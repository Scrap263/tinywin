/* ========================================
   TinyWin — App Logic (DeepSeek AI Edition)
   All decomposition powered by AI.
   ======================================== */

; (function () {
    'use strict';

    // ===================== Constants =====================
    const STUCK_TIMEOUT = 2 * 60 * 1000;
    const STORAGE_KEY = 'tinywin_state';
    const STORAGE_SETTINGS_KEY = 'tinywin_settings';
    const STORAGE_DAILY_KEY = 'tinywin_daily';

    // ===================== AI System Prompts =====================
    const SYSTEM_PROMPT = `Ты — ассистент для людей с СДВГ и исполнительной дисфункцией. Твоя единственная задача — разбить задачу пользователя на микро-шаги.

СТРОГИЕ ПРАВИЛА:
1. Каждый шаг — ОДНО физическое действие (встань, возьми, положи, открой, нажми, подойди).
2. Шаг должен занимать НЕ БОЛЕЕ 30 секунд.
3. Начинай с самого простого действия — "Встань", "Подойди к...", "Посмотри на...".
4. Используй повелительное наклонение (ты-форма).
5. НЕ группируй действия — одно действие = один шаг.
6. НЕ нумеруй шаги.
7. Будь тёплым и поддерживающим, но максимально лаконичным.
8. Последний шаг — позитивное подкрепление результата ("Посмотри — ты это сделал!", "Отличная работа!").
9. Генерируй 8–20 шагов в зависимости от сложности задачи.
10. Отвечай ТОЛЬКО списком шагов, каждый на отдельной строке.
11. Без нумерации, без тире, без маркеров, без лишнего текста.
12. Каждый шаг — простое короткое предложение на русском языке.

ПРИМЕР для "Помыть посуду":
Встань и подойди к кухне
Посмотри на раковину — просто посмотри
Включи воду
Возьми одну тарелку
Намыль её губкой
Ополосни под водой
Поставь в сушилку
Возьми следующий предмет
Намыль и ополосни
Повтори ещё для одного предмета
Протри столешницу тряпкой
Закрой воду
Вытри руки
Посмотри на чистую кухню — ты это сделал!`;

    const SPLIT_SYSTEM_PROMPT = `Ты — ассистент для людей с СДВГ. Пользователь застрял на конкретном шаге и ему нужно разбить его на ещё более мелкие части.

ПРАВИЛА:
1. Разбей один шаг на 2–4 ещё более простых микро-шага.
2. Каждый микро-шаг — одно ФИЗИЧЕСКОЕ действие (максимально атомарное).
3. Используй повелительное наклонение.
4. Первый шаг может быть "Просто подумай о том, чтобы..." — чтобы снизить порог входа.
5. Отвечай ТОЛЬКО списком шагов, каждый на отдельной строке, без нумерации, без маркеров.`;

    // ===================== AI API =====================
    async function callAI(systemPrompt, userMessage) {
        const url = settings.apiUrl.replace(/\/+$/, '') + '/chat/completions';
        const model = settings.apiModel || 'deepseek-chat';

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userMessage },
                ],
                temperature: 0.7,
                max_tokens: 1024,
            }),
        });

        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            throw new Error(`API ${response.status}: ${errBody.substring(0, 200)}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error('Пустой ответ от ИИ');
        return content;
    }

    function parseStepsFromAI(text) {
        return text
            .split('\n')
            .map((line) => line.replace(/^[\d\.\-\*\•\–\—\>\s]+/, '').trim())
            .filter((line) => line.length > 2 && line.length < 200);
    }

    async function aiDecompose(taskName) {
        const content = await callAI(SYSTEM_PROMPT, `Задача: "${taskName}"`);
        const steps = parseStepsFromAI(content);
        if (steps.length < 2) throw new Error('ИИ вернул слишком мало шагов');
        return steps;
    }

    async function aiSplitStep(stepText, taskContext) {
        const prompt = `Контекст задачи: "${taskContext}"\nШаг, на котором пользователь застрял: "${stepText}"\n\nРазбей этот шаг на 2–4 более простых микро-шага.`;
        const content = await callAI(SPLIT_SYSTEM_PROMPT, prompt);
        const steps = parseStepsFromAI(content);
        if (steps.length < 2) throw new Error('ИИ вернул слишком мало под-шагов');
        return steps;
    }

    // Emergency fallback (no AI, no templates — just generic steps)
    function emergencyFallback(taskName) {
        return [
            'Встань и подойди туда, где нужно это сделать',
            'Посмотри на ситуацию — просто посмотри',
            `Определи одно самое маленькое действие для «${taskName}»`,
            'Сделай это одно действие',
            'Сделай ещё одно маленькое действие',
            'И ещё одно',
            'Посмотри — уже лучше!',
            'Если есть силы — сделай ещё одно',
            'Ты молодец! Задача сдвинулась с места',
        ];
    }

    function emergencySplitFallback(stepText) {
        return [
            `Просто подумай о том, чтобы ${stepText.toLowerCase()}`,
            'А теперь просто сделай первое движение',
        ];
    }

    // ===================== State =====================
    let state = {
        currentScreen: 'splash',
        taskName: null,
        steps: [],
        currentStepIndex: 0,
        completedSteps: 0,
        microWins: 0,
        startedAt: null,
        stepStartedAt: null,
        isPaused: false,
        ambientPlaying: false,
        ambientType: 'brown',
    };

    let settings = {
        fullscreen: false,
        stuckDetect: true,
        haptic: true,
        ambientType: 'none',
        apiKey: '',
        apiUrl: 'https://api.deepseek.com',
        apiModel: 'deepseek-chat',
    };

    let daily = {
        date: new Date().toDateString(),
        totalMicroWins: 0,
        artPixels: [],
    };

    let stepTimer = null;
    let stuckTimer = null;
    let timerSeconds = 0;
    let audioCtx = null;
    let ambientNode = null;
    let ambientGain = null;
    let recognition = null;
    let isListening = false;

    // ===================== DOM =====================
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const screens = {};

    // ===================== Init =====================
    function init() {
        screens.splash = $('#screen-splash');
        screens.capture = $('#screen-capture');
        screens.decompose = $('#screen-decompose');
        screens.focus = $('#screen-focus');
        screens.pause = $('#screen-pause');
        screens.complete = $('#screen-complete');
        screens.art = $('#screen-art');

        loadState();
        loadSettings();
        loadDaily();
        setupEventListeners();
        setupSpeechRecognition();

        if (state.taskName && state.steps.length > 0 && state.currentStepIndex < state.steps.length) {
            showWelcomeBack();
        }
    }

    // ===================== Storage =====================
    function saveState() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { }
    }

    function loadState() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved) state = { ...state, ...JSON.parse(saved) };
        } catch (e) { }
    }

    function saveSettings() {
        try { localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { }
    }

    function loadSettings() {
        try {
            const saved = localStorage.getItem(STORAGE_SETTINGS_KEY);
            if (saved) settings = { ...settings, ...JSON.parse(saved) };
        } catch (e) { }
        syncSettingsUI();
    }

    function syncSettingsUI() {
        $('#setting-fullscreen').checked = settings.fullscreen;
        $('#setting-stuck-detect').checked = settings.stuckDetect;
        $('#setting-haptic').checked = settings.haptic;
        $('#setting-ambient-type').value = settings.ambientType;
    }

    function saveDaily() {
        try { localStorage.setItem(STORAGE_DAILY_KEY, JSON.stringify(daily)); } catch (e) { }
    }

    function loadDaily() {
        try {
            const saved = localStorage.getItem(STORAGE_DAILY_KEY);
            if (saved) {
                const parsed = JSON.parse(saved);
                if (parsed.date === new Date().toDateString()) {
                    daily = parsed;
                } else {
                    daily = { date: new Date().toDateString(), totalMicroWins: 0, artPixels: [] };
                }
            }
        } catch (e) { }
    }

    // ===================== Screens =====================
    function switchScreen(name) {
        Object.values(screens).forEach((s) => s && s.classList.remove('active'));
        if (screens[name]) {
            screens[name].classList.add('active');
            state.currentScreen = name;
            saveState();
        }
        const at = $('.ambient-toggle');
        if (at) at.style.display = name === 'focus' ? '' : 'none';
    }

    function showWelcomeBack() {
        const wb = $('#welcome-back');
        if (wb) {
            wb.style.display = '';
            const stepText = state.steps[state.currentStepIndex] || 'следующий шаг';
            $('#welcome-text').textContent = `С возвращением! Ты остановился на: «${stepText}». Продолжим?`;
        }
    }

    // ===================== Events =====================
    function setupEventListeners() {
        // Splash
        $('#btn-start').addEventListener('click', () => switchScreen('capture'));
        $('#btn-resume').addEventListener('click', () => {
            $('#welcome-back').style.display = 'none';
            switchScreen('focus');
            enterFocusMode();
        });
        $('#btn-new-task').addEventListener('click', () => {
            $('#welcome-back').style.display = 'none';
            clearTask();
            switchScreen('capture');
        });

        // Capture — voice
        $('#btn-voice').addEventListener('click', toggleVoice);

        // Capture — send / forward
        $('#btn-send').addEventListener('click', submitManualInput);
        $('#manual-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitManualInput();
        });

        // Decompose
        $('#btn-go').addEventListener('click', () => {
            switchScreen('focus');
            enterFocusMode();
        });
        $('#btn-retry-ai').addEventListener('click', () => retryDecompose());
        $('#btn-fallback').addEventListener('click', () => useFallbackSteps());

        // Focus
        $('#btn-done').addEventListener('click', completeStep);
        $('#btn-too-hard').addEventListener('click', (e) => { e.preventDefault(); showTooHardModal(); });
        $('#btn-pause').addEventListener('click', (e) => { e.preventDefault(); pauseTask(); });

        // Pause
        $('#btn-resume-pause').addEventListener('click', resumeFromPause);

        // Too hard modal
        $('#btn-split-yes').addEventListener('click', splitCurrentStep);
        $('#btn-split-no').addEventListener('click', () => {
            $('#modal-too-hard').style.display = 'none';
            resetStuckTimer();
        });

        // Complete
        $('#btn-another').addEventListener('click', () => { clearTask(); switchScreen('capture'); });
        $('#btn-view-art').addEventListener('click', () => { switchScreen('art'); renderArtView(); });

        // Art
        $('#btn-art-back').addEventListener('click', () => switchScreen('complete'));

        // Ambient
        $('#btn-ambient').addEventListener('click', toggleAmbient);

        // Settings
        $('#settings-gear').addEventListener('click', () => { $('#settings-panel').style.display = ''; });
        $('#btn-close-settings').addEventListener('click', () => { $('#settings-panel').style.display = 'none'; });
        $('#settings-panel').addEventListener('click', (e) => {
            if (e.target === $('#settings-panel')) $('#settings-panel').style.display = 'none';
        });

        $('#setting-fullscreen').addEventListener('change', (e) => { settings.fullscreen = e.target.checked; saveSettings(); });
        $('#setting-stuck-detect').addEventListener('change', (e) => { settings.stuckDetect = e.target.checked; saveSettings(); });
        $('#setting-haptic').addEventListener('change', (e) => { settings.haptic = e.target.checked; saveSettings(); });
        $('#setting-ambient-type').addEventListener('change', (e) => { settings.ambientType = e.target.value; saveSettings(); });



        $('#btn-reset-data').addEventListener('click', () => {
            if (confirm('Сбросить все данные? Это действие нельзя отменить.')) {
                localStorage.removeItem(STORAGE_KEY);
                localStorage.removeItem(STORAGE_SETTINGS_KEY);
                localStorage.removeItem(STORAGE_DAILY_KEY);
                location.reload();
            }
        });
    }

    // ===================== Voice =====================
    function setupSpeechRecognition() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) return;
        recognition = new SR();
        recognition.lang = 'ru-RU';
        recognition.continuous = false;
        recognition.interimResults = true;

        recognition.onresult = (event) => {
            let transcript = '';
            for (let i = 0; i < event.results.length; i++) {
                transcript += event.results[i][0].transcript;
            }
            $('#transcript-text').textContent = transcript;
            $('#voice-transcript').style.display = '';
            if (event.results[0].isFinal) {
                stopListening();
                const task = extractTask(transcript);
                setTimeout(() => startTask(task), 800);
            }
        };

        recognition.onerror = () => stopListening();
        recognition.onend = () => { if (isListening) stopListening(); };
    }

    function toggleVoice() { isListening ? stopListening() : startListening(); }

    function startListening() {
        if (!recognition) return;
        isListening = true;
        $('#btn-voice').classList.add('listening');
        $('#mic-icon').textContent = 'hearing';
        $('#voice-transcript').style.display = 'none';
        recognition.start();
    }

    function stopListening() {
        isListening = false;
        $('#btn-voice').classList.remove('listening');
        $('#mic-icon').textContent = 'mic';
        if (recognition) try { recognition.stop(); } catch (e) { }
    }

    function extractTask(transcript) {
        let task = transcript.trim();
        task = task.replace(/^(блин|ну|так|типа|короче|значит|ладно)[,\s]*/gi, '');
        task = task.charAt(0).toUpperCase() + task.slice(1);
        task = task.replace(/[.!]+$/, '').trim();
        return task.length > 120 ? task.substring(0, 120) : (task || 'Навести порядок');
    }

    // ===================== Task Flow =====================
    function submitManualInput() {
        const input = $('#manual-input');
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        startTask(text);
    }

    function startTask(taskName) {
        state.taskName = taskName;
        state.currentStepIndex = 0;
        state.completedSteps = 0;
        state.microWins = 0;
        state.startedAt = Date.now();
        state.steps = [];
        saveState();
        switchScreen('decompose');
        runDecompose(taskName);
    }

    async function runDecompose(taskName) {
        // Reset UI
        $('#thinking-animation').style.display = '';
        $('#decompose-title').textContent = 'ИИ разбирает задачу...';
        $('#decompose-subtitle').textContent = `«${taskName}»`;
        $('#decompose-ready').style.display = 'none';
        $('#decompose-error').style.display = 'none';

        try {
            const steps = await aiDecompose(taskName);
            state.steps = steps;
            saveState();

            // Show ready
            $('#thinking-animation').style.display = 'none';
            $('#decompose-title').textContent = 'Готово!';
            $('#decompose-subtitle').textContent = `${steps.length} микро-шагов — справишься!`;
            $('#decompose-ready').style.display = '';

            const readyText = $('#decompose-ready .ready-text');
            if (readyText) readyText.textContent = `ИИ разбил задачу на ${steps.length} простых шагов.`;
        } catch (err) {
            console.error('AI decompose error:', err);
            $('#thinking-animation').style.display = 'none';
            $('#decompose-title').textContent = 'Ой, не получилось';
            $('#decompose-subtitle').textContent = '';
            $('#decompose-ready').style.display = 'none';
            $('#decompose-error').style.display = '';
            const shortMsg = err.message.length > 120 ? err.message.substring(0, 120) + '...' : err.message;
            $('#decompose-error-text').textContent = shortMsg;
        }
    }

    function retryDecompose() {
        if (state.taskName) runDecompose(state.taskName);
    }

    function useFallbackSteps() {
        const steps = emergencyFallback(state.taskName || 'Навести порядок');
        state.steps = steps;
        saveState();
        $('#thinking-animation').style.display = 'none';
        $('#decompose-title').textContent = 'Готово!';
        $('#decompose-subtitle').textContent = `${steps.length} базовых шагов`;
        $('#decompose-error').style.display = 'none';
        $('#decompose-ready').style.display = '';
        const readyText = $('#decompose-ready .ready-text');
        if (readyText) readyText.textContent = `Задача разбита на ${steps.length} базовых шагов.`;
    }

    function enterFocusMode() {
        updateFocusUI();
        startStepTimer();
        resetStuckTimer();
        if (settings.fullscreen) {
            try { document.documentElement.requestFullscreen?.(); } catch (e) { }
        }
    }

    function updateFocusUI() {
        const step = state.steps[state.currentStepIndex];
        const total = state.steps.length;
        const progress = ((state.currentStepIndex) / total) * 100;

        const stepEl = $('#focus-step-text');
        stepEl.textContent = step;
        $('#focus-step-counter').textContent = `Шаг ${state.currentStepIndex + 1} из ${total}`;
        $('#focus-progress-fill').style.width = `${progress}%`;
        $('#focus-wins').textContent = `🔥 ${state.microWins}`;

        stepEl.classList.remove('step-enter', 'step-done');
        void stepEl.offsetWidth;
        stepEl.classList.add('step-enter');

        state.stepStartedAt = Date.now();
        saveState();
    }

    function completeStep() {
        if (settings.haptic && navigator.vibrate) navigator.vibrate([50, 30, 80]);

        state.completedSteps++;
        state.microWins++;
        daily.totalMicroWins++;
        addArtPixel();
        saveDaily();

        const stepEl = $('#focus-step-text');
        stepEl.classList.add('step-done');
        createSparkles();

        clearInterval(stepTimer);
        clearTimeout(stuckTimer);
        state.currentStepIndex++;
        saveState();

        if (state.currentStepIndex >= state.steps.length) {
            setTimeout(() => { exitFullscreen(); showComplete(); }, 400);
        } else {
            setTimeout(() => {
                timerSeconds = 0;
                updateFocusUI();
                startStepTimer();
                resetStuckTimer();
            }, 400);
        }
    }

    function pauseTask() {
        state.isPaused = true;
        saveState();
        clearInterval(stepTimer);
        clearTimeout(stuckTimer);
        stopAmbient();
        $('#pause-done-count').textContent = state.completedSteps;
        switchScreen('pause');
        exitFullscreen();
    }

    function resumeFromPause() {
        state.isPaused = false;
        saveState();
        switchScreen('focus');
        enterFocusMode();
    }

    function showTooHardModal() {
        clearTimeout(stuckTimer);
        const step = state.steps[state.currentStepIndex];
        $('#too-hard-text').textContent = `«${step}» — давай разобьём на ещё более простые шаги?`;
        $('#modal-too-hard').style.display = '';
    }

    async function splitCurrentStep() {
        $('#modal-too-hard').style.display = 'none';
        const currentStep = state.steps[state.currentStepIndex];

        // Show thinking in focus text
        const stepEl = $('#focus-step-text');
        stepEl.textContent = 'ИИ дробит шаг...';
        stepEl.classList.remove('step-enter', 'step-done');

        let subSteps;
        try {
            subSteps = await aiSplitStep(currentStep, state.taskName);
        } catch (err) {
            console.warn('AI split failed, using fallback:', err);
            subSteps = emergencySplitFallback(currentStep);
        }

        state.steps.splice(state.currentStepIndex, 1, ...subSteps);
        saveState();
        updateFocusUI();
        resetStuckTimer();
    }

    function showComplete() {
        switchScreen('complete');
        const statsEl = $('#complete-stats');
        if (statsEl) {
            statsEl.innerHTML = `За сегодня ты совершил <strong class="text-primary">${daily.totalMicroWins}</strong> маленьких действий.<br><span style="font-weight:300;color:var(--text-300)">Маленькая победа ведет к большим свершениям.</span>`;
        }
    }

    function clearTask() {
        state.taskName = null;
        state.steps = [];
        state.currentStepIndex = 0;
        state.completedSteps = 0;
        state.microWins = 0;
        state.startedAt = null;
        state.isPaused = false;
        saveState();
        clearInterval(stepTimer);
        clearTimeout(stuckTimer);
        stopAmbient();
        exitFullscreen();
        timerSeconds = 0;
    }

    // ===================== Timers =====================
    function startStepTimer() {
        timerSeconds = 0;
        $('#timer-display').textContent = '0:00';
        stepTimer = setInterval(() => {
            timerSeconds++;
            const m = Math.floor(timerSeconds / 60);
            const s = timerSeconds % 60;
            $('#timer-display').textContent = `${m}:${s.toString().padStart(2, '0')}`;
        }, 1000);
    }

    function resetStuckTimer() {
        clearTimeout(stuckTimer);
        if (settings.stuckDetect) {
            stuckTimer = setTimeout(() => showTooHardModal(), STUCK_TIMEOUT);
        }
    }

    function exitFullscreen() {
        if (document.fullscreenElement) document.exitFullscreen?.();
    }

    // ===================== Sparkles =====================
    function createSparkles() {
        const canvas = $('#sparkle-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        const particles = [];
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const colors = ['#4ade80', '#86efac', '#22c55e', '#bbf7d0', '#ffffff'];

        for (let i = 0; i < 35; i++) {
            const angle = (Math.PI * 2 * i) / 35;
            const speed = 2 + Math.random() * 5;
            particles.push({
                x: cx, y: cy,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                size: 2 + Math.random() * 4,
                color: colors[Math.floor(Math.random() * colors.length)],
                alpha: 1,
                decay: 0.015 + Math.random() * 0.02,
            });
        }

        function animate() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            let alive = false;
            particles.forEach((p) => {
                p.x += p.vx;
                p.y += p.vy;
                p.vy += 0.05;
                p.alpha -= p.decay;
                if (p.alpha > 0) {
                    alive = true;
                    ctx.globalAlpha = p.alpha;
                    ctx.fillStyle = p.color;
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                    ctx.fill();
                }
            });
            ctx.globalAlpha = 1;
            if (alive) requestAnimationFrame(animate);
            else ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        animate();
    }

    // ===================== Art =====================
    function addArtPixel() {
        const hue = 130 + (daily.artPixels.length * 3 + Math.random() * 20) % 60;
        const sat = 50 + Math.random() * 40;
        const light = 40 + Math.random() * 30;
        daily.artPixels.push({ hue, sat, light, x: Math.random(), y: Math.random(), size: 0.5 + Math.random() * 1.5 });
        saveDaily();
    }

    function renderArt(canvas) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        ctx.fillStyle = '#0a1a10';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const pixels = daily.artPixels;
        const gridSize = Math.ceil(Math.sqrt(pixels.length + 1));
        const cellW = canvas.width / gridSize;
        const cellH = canvas.height / gridSize;

        pixels.forEach((p, i) => {
            const col = i % gridSize;
            const row = Math.floor(i / gridSize);
            const cx = col * cellW + cellW / 2 + (p.x - 0.5) * cellW * 0.5;
            const cy = row * cellH + cellH / 2 + (p.y - 0.5) * cellH * 0.5;
            const radius = Math.min(cellW, cellH) * 0.3 * p.size;

            const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 2);
            gradient.addColorStop(0, `hsla(${p.hue}, ${p.sat}%, ${p.light}%, 0.8)`);
            gradient.addColorStop(0.5, `hsla(${p.hue}, ${p.sat}%, ${p.light}%, 0.2)`);
            gradient.addColorStop(1, `hsla(${p.hue}, ${p.sat}%, ${p.light}%, 0)`);
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(cx, cy, radius * 2, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = `hsl(${p.hue}, ${p.sat}%, ${p.light}%)`;
            ctx.beginPath();
            ctx.arc(cx, cy, radius * 0.4, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    function renderArtView() {
        renderArt($('#art-view-canvas'));
        $('#art-view-label').textContent = `Твой арт за сегодня — ${daily.totalMicroWins} микро-побед`;
    }

    // ===================== Ambient =====================
    function toggleAmbient() {
        if (state.ambientPlaying) {
            stopAmbient();
        } else {
            startAmbient(settings.ambientType !== 'none' ? settings.ambientType : 'brown');
        }
    }

    function startAmbient(type) {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        stopAmbient();

        ambientGain = audioCtx.createGain();
        ambientGain.gain.value = 0;
        ambientGain.connect(audioCtx.destination);

        if (type === 'brown') {
            const bufSize = 2 * audioCtx.sampleRate;
            const buf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate);
            const data = buf.getChannelData(0);
            let last = 0;
            for (let i = 0; i < bufSize; i++) {
                const w = Math.random() * 2 - 1;
                data[i] = (last + 0.02 * w) / 1.02;
                last = data[i];
                data[i] *= 3.5;
            }
            ambientNode = audioCtx.createBufferSource();
            ambientNode.buffer = buf;
            ambientNode.loop = true;
            ambientNode.connect(ambientGain);
            ambientNode.start();
        } else if (type === 'rain') {
            const bufSize = 2 * audioCtx.sampleRate;
            const buf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate);
            const data = buf.getChannelData(0);
            for (let i = 0; i < bufSize; i++) {
                data[i] = (Math.random() * 2 - 1) * 0.5;
                if (i > 0) data[i] = data[i] * 0.3 + data[i - 1] * 0.7;
            }
            ambientNode = audioCtx.createBufferSource();
            ambientNode.buffer = buf;
            ambientNode.loop = true;
            const filter = audioCtx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 2000;
            ambientNode.connect(filter);
            filter.connect(ambientGain);
            ambientNode.start();
        } else if (type === 'ticking') {
            createMetronome();
        }

        ambientGain.gain.linearRampToValueAtTime(0.15, audioCtx.currentTime + 1);
        state.ambientPlaying = true;
        state.ambientType = type;
        updateAmbientUI();
    }

    function createMetronome() {
        const tick = () => {
            if (!state.ambientPlaying) return;
            const osc = audioCtx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = 800;
            const tg = audioCtx.createGain();
            tg.gain.value = 0.05;
            tg.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.1);
            osc.connect(tg);
            tg.connect(audioCtx.destination);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.1);
            setTimeout(tick, 1000);
        };
        tick();
    }

    function stopAmbient() {
        if (ambientNode) { try { ambientNode.stop(); } catch (e) { } ambientNode = null; }
        if (ambientGain) { try { ambientGain.disconnect(); } catch (e) { } ambientGain = null; }
        state.ambientPlaying = false;
        updateAmbientUI();
    }

    function updateAmbientUI() {
        const btn = $('#btn-ambient');
        const label = $('#ambient-label');
        if (state.ambientPlaying) {
            btn.classList.add('active');
            const labels = { brown: 'Шум', rain: 'Дождь', ticking: 'Ритм' };
            label.textContent = labels[state.ambientType] || 'Играет';
        } else {
            btn.classList.remove('active');
            label.textContent = 'Тишина';
        }
    }

    // ===================== Bootstrap =====================
    document.addEventListener('DOMContentLoaded', init);
    window.addEventListener('beforeunload', () => { saveState(); saveDaily(); });
    window.addEventListener('resize', () => {
        const c = $('#sparkle-canvas');
        if (c) { c.width = window.innerWidth; c.height = window.innerHeight; }
    });
})();
