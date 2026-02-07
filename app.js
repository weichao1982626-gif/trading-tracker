/**
 * K-Line Sentience (K线觉醒)
 * 
 * 模块化架构：
 * - ConfigManager: API 配置管理
 * - ImageHandler: 图片上传/预处理
 * - ClaudeVision: AI 视觉分析接口
 * - ReportRenderer: 报告渲染引擎
 * - EventBus: 事件总线解耦
 * - App: 主控制器
 */

'use strict';

// ============================================
// EventBus - 事件总线（发布/订阅模式解耦）
// ============================================
const EventBus = (() => {
    const events = new Map();

    return {
        /**
         * 订阅事件
         * @param {string} event - 事件名
         * @param {Function} callback - 回调函数
         * @returns {Function} unsubscribe function
         */
        on(event, callback) {
            if (!events.has(event)) {
                events.set(event, new Set());
            }
            events.get(event).add(callback);

            // 返回取消订阅函数
            return () => events.get(event)?.delete(callback);
        },

        /**
         * 发布事件
         * @param {string} event - 事件名
         * @param {any} data - 事件数据
         */
        emit(event, data) {
            if (events.has(event)) {
                events.get(event).forEach(callback => {
                    try {
                        callback(data);
                    } catch (error) {
                        console.error(`EventBus error on "${event}":`, error);
                    }
                });
            }
        },

        /**
         * 一次性订阅
         */
        once(event, callback) {
            const unsubscribe = this.on(event, (data) => {
                unsubscribe();
                callback(data);
            });
        }
    };
})();

// ============================================
// ConfigManager - 配置管理器
// ============================================
const ConfigManager = (() => {
    const STORAGE_KEY = 'kline_sentience_config';

    const defaults = {
        apiKey: '',
        apiEndpoint: 'https://api.anthropic.com/v1/messages',
        model: 'claude-sonnet-4-20250514',
        maxImageSize: 10 * 1024 * 1024, // 10MB
        acceptedTypes: ['image/png', 'image/jpeg', 'image/webp']
    };

    let config = { ...defaults };

    // 从 localStorage 加载
    const load = () => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                config = { ...defaults, ...parsed };
            }
        } catch (e) {
            console.warn('Failed to load config:', e);
        }
    };

    // 保存到 localStorage
    const save = () => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                apiKey: config.apiKey
            }));
        } catch (e) {
            console.warn('Failed to save config:', e);
        }
    };

    load();

    return {
        get(key) {
            return config[key];
        },

        set(key, value) {
            config[key] = value;
            save();
            EventBus.emit('config:changed', { key, value });
        },

        hasApiKey() {
            return !!config.apiKey && config.apiKey.startsWith('sk-');
        },

        getAll() {
            return { ...config };
        }
    };
})();

// ============================================
// ImageHandler - 图片处理模块
// ============================================
const ImageHandler = (() => {
    let currentImage = null;

    /**
     * 验证图片文件
     */
    const validate = (file) => {
        const config = ConfigManager.getAll();

        if (!config.acceptedTypes.includes(file.type)) {
            throw new Error(`不支持的图片格式: ${file.type}`);
        }

        if (file.size > config.maxImageSize) {
            throw new Error(`图片过大，最大支持 ${config.maxImageSize / 1024 / 1024}MB`);
        }

        return true;
    };

    /**
     * 读取文件为 Base64
     */
    const readAsBase64 = (file) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('文件读取失败'));
            reader.readAsDataURL(file);
        });
    };

    /**
     * 从 DataURL 中提取纯 Base64
     */
    const extractBase64 = (dataUrl) => {
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) throw new Error('无效的图片数据');
        return {
            mediaType: match[1],
            base64: match[2]
        };
    };

    /**
     * 处理图片（压缩、优化）
     */
    const processImage = async (file) => {
        // 对于大图片进行压缩
        if (file.size > 2 * 1024 * 1024) {
            return await compressImage(file);
        }
        return await readAsBase64(file);
    };

    /**
     * 压缩图片
     */
    const compressImage = (file, maxWidth = 2048, quality = 0.85) => {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            img.onload = () => {
                let { width, height } = img;

                // 计算缩放比例
                if (width > maxWidth) {
                    height = Math.round(height * (maxWidth / width));
                    width = maxWidth;
                }

                canvas.width = width;
                canvas.height = height;
                ctx.drawImage(img, 0, 0, width, height);

                resolve(canvas.toDataURL('image/jpeg', quality));
            };

            img.onerror = () => reject(new Error('图片加载失败'));
            img.src = URL.createObjectURL(file);
        });
    };

    return {
        /**
         * 处理上传的文件
         */
        async handleFile(file) {
            validate(file);
            const dataUrl = await processImage(file);
            currentImage = {
                file,
                dataUrl,
                ...extractBase64(dataUrl)
            };

            EventBus.emit('image:loaded', currentImage);
            return currentImage;
        },

        /**
         * 处理粘贴的图片
         */
        async handlePaste(clipboardData) {
            const items = clipboardData.items;
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    const file = item.getAsFile();
                    return await this.handleFile(file);
                }
            }
            throw new Error('剪贴板中没有图片');
        },

        /**
         * 处理拖拽的文件
         */
        async handleDrop(dataTransfer) {
            const files = dataTransfer.files;
            if (files.length === 0) {
                throw new Error('没有检测到文件');
            }
            return await this.handleFile(files[0]);
        },

        /**
         * 获取当前图片
         */
        getCurrent() {
            return currentImage;
        },

        /**
         * 清除当前图片
         */
        clear() {
            currentImage = null;
            EventBus.emit('image:cleared');
        }
    };
})();

// ============================================
// ClaudeVision - Claude 视觉分析接口
// ============================================
const ClaudeVision = (() => {
    // 威科夫 + 2B 反转专家系统提示词
    const EXPERT_SYSTEM_PROMPT = `你是一位顶级操盘手，精通威科夫理论和价格行为分析。你需要分析用户提供的K线图，提供专业的技术分析报告。

## 必须执行的分析步骤：

### 1. 形态识别优先
- 主动搜索 2B 反转信号（Spring/Upthrust）
- 识别威科夫派发/吸筹区间（Accumulation/Distribution）
- 标记关键压力/支撑位的虚假突破（False Breakout）

### 2. 经典K线组合识别
- 黄昏之星（Evening Star）、启明星（Morning Star）
- 吞没形态（Engulfing Pattern）
- 十字星（Doji）、锤子线（Hammer）、上吊线（Hanging Man）
- 三只乌鸦、三个白兵

### 3. 量价分析（如图中有成交量）
- 检查"努力与结果不匹配"异动（Effort vs Result）
- 分析放量/缩量配合情况
- 识别异常成交量信号

## 硬性风控准则（必须遵守）：
- **单次止损不超过账户 3%**

## 输出格式（必须严格遵循JSON格式）：

请以纯JSON格式返回分析结果，不要包含任何其他文字：

{
    "phase": "当前阶段，如：吸筹/派发/上涨趋势/下跌趋势/盘整震荡",
    "phaseType": "bullish/bearish/neutral",
    "resistance": "压力位价格，如无法识别则为null",
    "support": "支撑位价格，如无法识别则为null",
    "pattern2B": {
        "status": "confirmed/pending/none",
        "description": "2B形态的具体描述"
    },
    "action": {
        "buyLevel": "建议买入位，如不建议买入则为null",
        "sellLevel": "建议卖出位，如不建议卖出则为null",
        "stopLoss": "严格止损位"
    },
    "risk": "风险提示，具体说明当前的主要风险点",
    "relatedStocks": [
        {"code": "股票代码", "name": "股票名称", "reason": "关联理由"}
    ],
    "analysis": "详细分析文字，包含形态识别结果、量价分析、趋势判断等"
}

注意事项：
1. 价格请根据图中实际显示的价格来填写
2. 如果无法从图中识别某项信息，请如实说明
3. 关联A股需要根据识别出的品种（如期货、ETF等）来推荐`;

    /**
     * 调用 Claude Vision API
     */
    const callAPI = async (imageData, onProgress) => {
        const apiKey = ConfigManager.get('apiKey');
        const endpoint = ConfigManager.get('apiEndpoint');
        const model = ConfigManager.get('model');

        if (!apiKey) {
            throw new Error('请先配置 API Key');
        }

        onProgress?.('正在连接 Claude Vision...');

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: JSON.stringify({
                model,
                max_tokens: 4096,
                system: EXPERT_SYSTEM_PROMPT,
                messages: [{
                    role: 'user',
                    content: [
                        {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: imageData.mediaType,
                                data: imageData.base64
                            }
                        },
                        {
                            type: 'text',
                            text: '请分析这张K线图，按照系统提示词中的JSON格式返回分析结果。'
                        }
                    ]
                }]
            })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error?.message || `API 请求失败: ${response.status}`);
        }

        onProgress?.('AI 正在深度分析...');

        const data = await response.json();
        return data.content[0].text;
    };

    /**
     * 解析 AI 响应
     */
    const parseResponse = (text) => {
        try {
            // 尝试直接解析 JSON
            return JSON.parse(text);
        } catch (e) {
            // 如果失败，尝试从文本中提取 JSON
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    return JSON.parse(jsonMatch[0]);
                } catch (e2) {
                    console.warn('JSON parse retry failed:', e2);
                }
            }

            // 返回原始文本的结构化形式
            return {
                phase: '分析完成',
                phaseType: 'neutral',
                analysis: text,
                error: '响应格式解析异常，请查看详细分析'
            };
        }
    };

    return {
        /**
         * 分析图片
         */
        async analyze(imageData, onProgress) {
            EventBus.emit('analysis:start');

            try {
                onProgress?.('识别K线形态中...');
                const rawResponse = await callAPI(imageData, onProgress);

                onProgress?.('解析分析结果...');
                const result = parseResponse(rawResponse);

                EventBus.emit('analysis:complete', result);
                return result;
            } catch (error) {
                EventBus.emit('analysis:error', error);
                throw error;
            }
        },

        /**
         * 获取系统提示词（调试用）
         */
        getSystemPrompt() {
            return EXPERT_SYSTEM_PROMPT;
        }
    };
})();

// ============================================
// ReportRenderer - 报告渲染引擎
// ============================================
const ReportRenderer = (() => {
    // DOM 元素缓存
    const elements = {};

    /**
     * 初始化 DOM 引用
     */
    const initElements = () => {
        elements.empty = document.getElementById('reportEmpty');
        elements.loading = document.getElementById('reportLoading');
        elements.content = document.getElementById('reportContent');
        elements.badge = document.getElementById('reportBadge');
        elements.loadingStep = document.getElementById('loadingStep');

        // 报告内容元素
        elements.phaseTag = document.getElementById('phaseTag');
        elements.resistance = document.getElementById('resistanceLevel');
        elements.support = document.getElementById('supportLevel');
        elements.patternStatus = document.getElementById('patternStatus');
        elements.buyLevel = document.getElementById('buyLevel');
        elements.sellLevel = document.getElementById('sellLevel');
        elements.stopLoss = document.getElementById('stopLossLevel');
        elements.riskText = document.getElementById('riskText');
        elements.relatedStocks = document.getElementById('relatedStocks');
        elements.analysisText = document.getElementById('analysisText');
    };

    /**
     * 显示状态
     */
    const showState = (state) => {
        elements.empty?.classList.toggle('hidden', state !== 'empty');
        elements.loading?.classList.toggle('active', state === 'loading');
        elements.content?.classList.toggle('active', state === 'content');

        // 更新 badge
        if (elements.badge) {
            elements.badge.className = 'report-badge';
            switch (state) {
                case 'loading':
                    elements.badge.textContent = '分析中';
                    elements.badge.classList.add('analyzing');
                    break;
                case 'content':
                    elements.badge.textContent = '分析完成';
                    elements.badge.classList.add('complete');
                    break;
                default:
                    elements.badge.textContent = '等待输入';
            }
        }
    };

    /**
     * 更新加载步骤
     */
    const updateLoadingStep = (text) => {
        if (elements.loadingStep) {
            elements.loadingStep.textContent = text;
        }
    };

    /**
     * 渲染价格
     */
    const formatPrice = (value) => {
        if (value === null || value === undefined || value === 'null') {
            return '--';
        }
        if (typeof value === 'number') {
            return `¥${value.toLocaleString()}`;
        }
        // 如果已经包含货币符号
        if (String(value).includes('¥') || String(value).includes('$')) {
            return value;
        }
        return `¥${value}`;
    };

    /**
     * 渲染关联股票
     */
    const renderStocks = (stocks) => {
        if (!stocks || !Array.isArray(stocks) || stocks.length === 0) {
            return '<span style="color: var(--text-tertiary)">暂无关联推荐</span>';
        }

        return stocks.map(stock => `
            <div class="stock-tag">
                <span class="stock-code">${stock.code || '--'}</span>
                <span class="stock-name">${stock.name || ''}</span>
            </div>
        `).join('');
    };

    /**
     * 获取阶段类型样式
     */
    const getPhaseClass = (phaseType) => {
        switch (phaseType) {
            case 'bullish': return 'bullish';
            case 'bearish': return 'bearish';
            default: return '';
        }
    };

    /**
     * 获取形态状态样式
     */
    const getPatternClass = (status) => {
        switch (status) {
            case 'confirmed': return 'confirmed';
            case 'pending': return 'pending';
            default: return 'none';
        }
    };

    /**
     * 获取形态状态文字
     */
    const getPatternText = (pattern) => {
        if (!pattern) return '--';
        const statusMap = {
            'confirmed': '✅ 已确认',
            'pending': '⏳ 等待确认',
            'none': '❌ 未出现'
        };
        const status = statusMap[pattern.status] || pattern.status;
        return pattern.description ? `${status} - ${pattern.description}` : status;
    };

    return {
        /**
         * 初始化
         */
        init() {
            initElements();

            // 订阅事件
            EventBus.on('analysis:start', () => showState('loading'));
            EventBus.on('analysis:complete', (data) => this.render(data));
            EventBus.on('analysis:error', (error) => this.renderError(error));
            EventBus.on('image:cleared', () => showState('empty'));
        },

        /**
         * 更新加载状态
         */
        setLoadingStep(text) {
            updateLoadingStep(text);
        },

        /**
         * 渲染报告
         */
        render(data) {
            showState('content');

            // 阶段
            if (elements.phaseTag) {
                elements.phaseTag.textContent = data.phase || '--';
                elements.phaseTag.className = `phase-tag ${getPhaseClass(data.phaseType)}`;
            }

            // 关键位
            if (elements.resistance) {
                elements.resistance.textContent = formatPrice(data.resistance);
            }
            if (elements.support) {
                elements.support.textContent = formatPrice(data.support);
            }

            // 2B 形态
            if (elements.patternStatus) {
                elements.patternStatus.textContent = getPatternText(data.pattern2B);
                elements.patternStatus.className = `pattern-status ${getPatternClass(data.pattern2B?.status)}`;
            }

            // 操作建议
            if (data.action) {
                if (elements.buyLevel) {
                    elements.buyLevel.textContent = formatPrice(data.action.buyLevel);
                }
                if (elements.sellLevel) {
                    elements.sellLevel.textContent = formatPrice(data.action.sellLevel);
                }
                if (elements.stopLoss) {
                    elements.stopLoss.textContent = formatPrice(data.action.stopLoss);
                }
            }

            // 风险提示
            if (elements.riskText) {
                elements.riskText.textContent = data.risk || '--';
            }

            // 关联股票
            if (elements.relatedStocks) {
                elements.relatedStocks.innerHTML = renderStocks(data.relatedStocks);
            }

            // 详细分析
            if (elements.analysisText) {
                elements.analysisText.textContent = data.analysis || '--';
            }

            // 入场动画
            this.animateCards();
        },

        /**
         * 渲染错误
         */
        renderError(error) {
            showState('content');

            if (elements.phaseTag) {
                elements.phaseTag.textContent = '分析失败';
                elements.phaseTag.className = 'phase-tag bearish';
            }

            if (elements.analysisText) {
                elements.analysisText.textContent = `错误: ${error.message}\n\n请检查：\n1. API Key 是否正确配置\n2. 网络连接是否正常\n3. 图片格式是否支持`;
            }
        },

        /**
         * 卡片入场动画
         */
        animateCards() {
            const cards = elements.content?.querySelectorAll('.report-card');
            cards?.forEach((card, index) => {
                card.style.opacity = '0';
                card.style.transform = 'translateY(20px)';

                setTimeout(() => {
                    card.style.transition = 'all 0.4s ease';
                    card.style.opacity = '1';
                    card.style.transform = 'translateY(0)';
                }, index * 80);
            });
        },

        /**
         * 重置
         */
        reset() {
            showState('empty');
        }
    };
})();

// ============================================
// UploadUI - 上传区域 UI 控制
// ============================================
const UploadUI = (() => {
    let elements = {};

    const initElements = () => {
        elements.zone = document.getElementById('uploadZone');
        elements.btn = document.getElementById('uploadBtn');
        elements.input = document.getElementById('fileInput');
        elements.preview = document.getElementById('previewContainer');
        elements.previewImg = document.getElementById('previewImage');
        elements.closeBtn = document.getElementById('previewClose');
        elements.analyzeBtn = document.getElementById('analyzeBtn');
    };

    const showPreview = (dataUrl) => {
        if (elements.previewImg) {
            elements.previewImg.src = dataUrl;
        }
        elements.zone?.classList.add('has-image');
    };

    const hidePreview = () => {
        elements.zone?.classList.remove('has-image');
        if (elements.previewImg) {
            elements.previewImg.src = '';
        }
    };

    return {
        init() {
            initElements();

            // 点击上传按钮
            elements.btn?.addEventListener('click', (e) => {
                e.stopPropagation();
                elements.input?.click();
            });

            // 点击上传区域
            elements.zone?.addEventListener('click', () => {
                if (!elements.zone.classList.contains('has-image')) {
                    elements.input?.click();
                }
            });

            // 文件选择
            elements.input?.addEventListener('change', async (e) => {
                const file = e.target.files?.[0];
                if (file) {
                    try {
                        await ImageHandler.handleFile(file);
                    } catch (error) {
                        alert(error.message);
                    }
                }
                e.target.value = ''; // 重置
            });

            // 拖拽事件
            elements.zone?.addEventListener('dragover', (e) => {
                e.preventDefault();
                elements.zone.classList.add('drag-over');
            });

            elements.zone?.addEventListener('dragleave', (e) => {
                e.preventDefault();
                elements.zone.classList.remove('drag-over');
            });

            elements.zone?.addEventListener('drop', async (e) => {
                e.preventDefault();
                elements.zone.classList.remove('drag-over');
                try {
                    await ImageHandler.handleDrop(e.dataTransfer);
                } catch (error) {
                    alert(error.message);
                }
            });

            // 粘贴事件（全局）
            document.addEventListener('paste', async (e) => {
                try {
                    await ImageHandler.handlePaste(e.clipboardData);
                } catch (error) {
                    // 静默失败（可能不是图片粘贴）
                    console.log('Paste:', error.message);
                }
            });

            // 关闭预览
            elements.closeBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                ImageHandler.clear();
            });

            // 开始分析
            elements.analyzeBtn?.addEventListener('click', async () => {
                const image = ImageHandler.getCurrent();
                if (!image) return;

                if (!ConfigManager.hasApiKey()) {
                    EventBus.emit('modal:show', 'api');
                    return;
                }

                elements.analyzeBtn.disabled = true;
                try {
                    await ClaudeVision.analyze(image, (step) => {
                        ReportRenderer.setLoadingStep(step);
                    });
                } catch (error) {
                    alert(`分析失败: ${error.message}`);
                } finally {
                    elements.analyzeBtn.disabled = false;
                }
            });

            // 订阅事件
            EventBus.on('image:loaded', (data) => showPreview(data.dataUrl));
            EventBus.on('image:cleared', hidePreview);
        }
    };
})();

// ============================================
// ModalUI - 模态框控制
// ============================================
const ModalUI = (() => {
    let elements = {};

    const initElements = () => {
        elements.modal = document.getElementById('apiModal');
        elements.closeBtn = document.getElementById('modalClose');
        elements.cancelBtn = document.getElementById('cancelApi');
        elements.saveBtn = document.getElementById('saveApi');
        elements.keyInput = document.getElementById('apiKeyInput');
        elements.toggleBtn = document.getElementById('toggleKey');
    };

    const show = () => {
        elements.modal?.classList.add('active');
        elements.keyInput?.focus();
    };

    const hide = () => {
        elements.modal?.classList.remove('active');
    };

    const toggleVisibility = () => {
        if (elements.keyInput) {
            const isPassword = elements.keyInput.type === 'password';
            elements.keyInput.type = isPassword ? 'text' : 'password';
        }
    };

    const save = () => {
        const key = elements.keyInput?.value?.trim();
        if (!key) {
            alert('请输入 API Key');
            return;
        }
        if (!key.startsWith('sk-')) {
            alert('API Key 格式不正确，应以 sk- 开头');
            return;
        }

        ConfigManager.set('apiKey', key);
        hide();

        // 自动触发分析
        const image = ImageHandler.getCurrent();
        if (image) {
            document.getElementById('analyzeBtn')?.click();
        }
    };

    return {
        init() {
            initElements();

            // 加载已保存的 key
            const savedKey = ConfigManager.get('apiKey');
            if (savedKey && elements.keyInput) {
                elements.keyInput.value = savedKey;
            }

            // 事件绑定
            elements.closeBtn?.addEventListener('click', hide);
            elements.cancelBtn?.addEventListener('click', hide);
            elements.saveBtn?.addEventListener('click', save);
            elements.toggleBtn?.addEventListener('click', toggleVisibility);

            // ESC 关闭
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && elements.modal?.classList.contains('active')) {
                    hide();
                }
            });

            // 点击背景关闭
            elements.modal?.addEventListener('click', (e) => {
                if (e.target === elements.modal) {
                    hide();
                }
            });

            // Enter 保存
            elements.keyInput?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    save();
                }
            });

            // 订阅事件
            EventBus.on('modal:show', (type) => {
                if (type === 'api') show();
            });
        }
    };
})();

// ============================================
// ExpandableCards - 可展开卡片控制
// ============================================
const ExpandableCards = (() => {
    return {
        init() {
            const expandBtn = document.getElementById('expandAnalysis');
            const analysisBody = expandBtn?.closest('.report-card')?.querySelector('.analysis-body');

            expandBtn?.addEventListener('click', () => {
                expandBtn.classList.toggle('expanded');
                analysisBody?.classList.toggle('expanded');
            });
        }
    };
})();

// ============================================
// App - 主控制器
// ============================================
const App = (() => {
    return {
        /**
         * 初始化应用
         */
        init() {
            console.log('🚀 K-Line Sentience initializing...');

            // 初始化各模块
            ReportRenderer.init();
            UploadUI.init();
            ModalUI.init();
            ExpandableCards.init();

            // 检查 API Key 状态
            if (ConfigManager.hasApiKey()) {
                console.log('✅ API Key configured');
            } else {
                console.log('⚠️ API Key not configured');
            }

            console.log('✨ K-Line Sentience ready!');
        }
    };
})();

// 启动应用
document.addEventListener('DOMContentLoaded', () => App.init());
