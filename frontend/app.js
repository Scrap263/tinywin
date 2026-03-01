/* ========================================
   TinyWin — Frontend (Backend-Powered)
   All AI calls go through /api/ai/*
   Auth via /api/auth/*
   ======================================== */

; (function () {
    'use strict';

    // ===================== Constants =====================
    const STUCK_TIMEOUT = 2 * 60 * 1000;
    const API_BASE = '';  // same origin — FastAPI serves frontend

    // ===================== Auth State =====================
    let authToken = localStorage.getItem('tinywin_token') || null;
    let currentUser = null;
    let isGuest = false; // guest mode (no auth, local-only, limited)

    // ===================== App State =====================
    let state = {
        currentScreen: 'auth',
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

    // ===================== API Helpers =====================
    async function api(method, path, body = null) {
        const headers = { 'Content-Type': 'application/json' };
        if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

        const opts = { method, headers };
        if (body) opts.body = JSON.stringify(body);

        const resp = await fetch(API_BASE + path, opts);
        const data = await resp.json();

        if (!resp.ok) {
            const detail = data.detail;
            if (resp.status === 429 && detail?.error === 'limit_reached') {
                showPaywall(detail.message);
                throw new Error('LIMIT');
            }
            const msg = typeof detail === 'string' ? detail : detail?.message || `Ошибка ${resp.status}`;
            throw new Error(msg);
        }
        return data;
    }

    // ===================== Init =====================
    function init() {
        screens.auth = $('#screen-auth');
        screens.verify = $('#screen-verify');
        screens.splash = $('#screen-splash');
        screens.capture = $('#screen-capture');
        screens.decompose = $('#screen-decompose');
        screens.focus = $('#screen-focus');
        screens.pause = $('#screen-pause');
        screens.complete = $('#screen-complete');
        screens.art = $('#screen-art');

        loadLocalState();
        loadLocalSettings();
        loadLocalDaily();
        setupEventListeners();
        setupSpeechRecognition();
        setupGoogleAuth();

        // Try auto-login if token exists
        if (authToken) {
            tryAutoLogin();
        }
        // else stay on auth screen
    }

    async function tryAutoLogin() {
        try {
            currentUser = await api('GET', '/api/auth/me');
            if (!currentUser.is_verified) {
                showVerifyScreen(currentUser.email);
                return;
            }
            onAuthSuccess();
        } catch (e) {
            // Token expired — stay on auth
            authToken = null;
            localStorage.removeItem('tinywin_token');
        }
    }

    function onAuthSuccess() {
        // Show user info in settings
        const userInfoEl = $('#settings-user-info');
        if (userInfoEl && currentUser) {
            userInfoEl.style.display = '';
            $('#settings-user-email').textContent = currentUser.email;
        }

        // Load server progress
        loadServerProgress().then(() => {
            if (state.taskName && state.steps.length > 0 && state.currentStepIndex < state.steps.length) {
                switchScreen('splash');
                showWelcomeBack();
            } else {
                switchScreen('splash');
            }
        });
    }

    function onGuestMode() {
        isGuest = true;
        authToken = null;
        switchScreen('splash');
    }

    // ===================== Storage (local fallback) =====================
    function saveLocalState() {
        try { localStorage.setItem('tinywin_state', JSON.stringify(state)); } catch (e) { }
    }

    function loadLocalState() {
        try {
            const saved = localStorage.getItem('tinywin_state');
            if (saved) state = { ...state, ...JSON.parse(saved) };
        } catch (e) { }
    }

    function saveLocalSettings() {
        try { localStorage.setItem('tinywin_settings', JSON.stringify(settings)); } catch (e) { }
    }

    function loadLocalSettings() {
        try {
            const saved = localStorage.getItem('tinywin_settings');
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

    function saveLocalDaily() {
        try { localStorage.setItem('tinywin_daily', JSON.stringify(daily)); } catch (e) { }
    }

    function loadLocalDaily() {
        try {
            const saved = localStorage.getItem('tinywin_daily');
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

    // ===================== Server sync =====================
    async function loadServerProgress() {
        if (isGuest || !authToken) return;
        try {
            const data = await api('GET', '/api/user/progress');
            if (data.state && Object.keys(data.state).length > 0) {
                state = { ...state, ...data.state };
            }
            if (data.daily && Object.keys(data.daily).length > 0) {
                daily = { ...daily, ...data.daily };
            }
            if (data.settings && Object.keys(data.settings).length > 0) {
                settings = { ...settings, ...data.settings };
                syncSettingsUI();
            }
        } catch (e) {
            console.warn('Failed to load server progress:', e);
        }
    }

    async function saveServerProgress() {
        if (isGuest || !authToken) return;
        try {
            await api('POST', '/api/user/progress', {
                state: state,
                daily: daily,
                settings: settings,
            });
        } catch (e) {
            console.warn('Failed to save server progress:', e);
        }
    }

    function saveAll() {
        saveLocalState();
        saveLocalDaily();
        saveLocalSettings();
        saveServerProgress(); // async, fire-and-forget
    }

    // ===================== Screens =====================
    function switchScreen(name) {
        Object.values(screens).forEach((s) => s && s.classList.remove('active'));
        if (screens[name]) {
            screens[name].classList.add('active');
            state.currentScreen = name;
            saveLocalState();
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

    // ===================== Paywall =====================
    function showPaywall(message) {
        $('#paywall-text').textContent = message || 'Лимит бесплатных запросов исчерпан на сегодня.';
        $('#modal-paywall').style.display = '';
    }

    // ===================== Events =====================
    function setupEventListeners() {
        // Auth
        $('#btn-login').addEventListener('click', doLogin);
        $('#btn-register').addEventListener('click', doRegister);
        $('#btn-skip-auth').addEventListener('click', onGuestMode);
        $('#auth-password').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doLogin();
        });

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

        // Capture
        $('#btn-voice').addEventListener('click', toggleVoice);
        $('#btn-send').addEventListener('click', submitManualInput);
        $('#manual-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitManualInput();
        });

        // Decompose
        $('#btn-go').addEventListener('click', () => { switchScreen('focus'); enterFocusMode(); });
        $('#btn-retry-ai').addEventListener('click', retryDecompose);
        $('#btn-fallback').addEventListener('click', useFallbackSteps);

        // Focus
        $('#btn-done').addEventListener('click', completeStep);
        $('#btn-too-hard').addEventListener('click', (e) => { e.preventDefault(); showTooHardModal(); });
        $('#btn-pause').addEventListener('click', (e) => { e.preventDefault(); pauseTask(); });

        // Pause
        $('#btn-resume-pause').addEventListener('click', resumeFromPause);

        // Too hard
        $('#btn-split-yes').addEventListener('click', splitCurrentStep);
        $('#btn-split-no').addEventListener('click', () => {
            $('#modal-too-hard').style.display = 'none';
            resetStuckTimer();
        });

        // Complete
        $('#btn-another').addEventListener('click', () => { clearTask(); switchScreen('capture'); });
        $('#btn-view-art').addEventListener('click', () => { switchScreen('art'); renderArtView(); });
        $('#btn-art-back').addEventListener('click', () => switchScreen('complete'));

        // Ambient
        $('#btn-ambient').addEventListener('click', toggleAmbient);

        // Settings
        $('#settings-gear').addEventListener('click', () => { $('#settings-panel').style.display = ''; });
        $('#btn-close-settings').addEventListener('click', () => { $('#settings-panel').style.display = 'none'; });
        $('#settings-panel').addEventListener('click', (e) => {
            if (e.target === $('#settings-panel')) $('#settings-panel').style.display = 'none';
        });

        $('#setting-fullscreen').addEventListener('change', (e) => { settings.fullscreen = e.target.checked; saveAll(); });
        $('#setting-stuck-detect').addEventListener('change', (e) => { settings.stuckDetect = e.target.checked; saveAll(); });
        $('#setting-haptic').addEventListener('change', (e) => { settings.haptic = e.target.checked; saveAll(); });
        $('#setting-ambient-type').addEventListener('change', (e) => { settings.ambientType = e.target.value; saveAll(); });

        // Logout
        $('#btn-logout').addEventListener('click', doLogout);

        // Reset
        $('#btn-reset-data').addEventListener('click', () => {
            if (confirm('Сбросить все данные? Это действие нельзя отменить.')) {
                localStorage.clear();
                location.reload();
            }
        });

        // Paywall
        $('#btn-close-paywall').addEventListener('click', () => { $('#modal-paywall').style.display = 'none'; });

        // Email verification
        $('#btn-verify').addEventListener('click', doVerify);
        $('#btn-resend').addEventListener('click', doResend);
        $('#verify-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doVerify(); });
    }

    // ===================== Auth Actions =====================
    async function setupGoogleAuth() {
        try {
            const config = await fetch('/api/auth/config').then(r => r.json());
            if (config.google_client_id) {
                // Wait for SDK to load if not yet ready
                if (!window.google || !window.google.accounts) {
                    setTimeout(setupGoogleAuth, 200);
                    return;
                }

                window.google.accounts.id.initialize({
                    client_id: config.google_client_id,
                    callback: handleGoogleCredentialResponse,
                    context: "use",
                    ux_mode: "popup"
                });
                window.google.accounts.id.renderButton(
                    document.getElementById("google-signin-btn-wrap"),
                    { theme: "filled_black", size: "large", type: "standard", shape: "pill", locale: "ru", width: 280 }
                );
            } else {
                const divider = document.getElementById("google-divider");
                const btnWrap = document.getElementById("google-signin-btn-wrap");
                if (divider) divider.style.display = 'none';
                if (btnWrap) btnWrap.style.display = 'none';
            }
        } catch (e) {
            console.error("Failed to load Google Auth config", e);
        }
    }

    async function handleGoogleCredentialResponse(response) {
        try {
            const data = await api('POST', '/api/auth/google', { credential: response.credential });
            authToken = data.token;
            currentUser = data.user;
            localStorage.setItem('tinywin_token', authToken);
            if (!currentUser.is_verified) {
                showVerifyScreen(currentUser.email);
            } else {
                onAuthSuccess();
            }
        } catch (e) {
            showAuthError(e.message || "Ошибка авторизации через Google");
        }
    }

    function showAuthError(msg) {
        const el = $('#auth-error');
        el.textContent = msg;
        el.style.display = '';
    }

    async function doLogin() {
        const email = $('#auth-email').value.trim();
        const password = $('#auth-password').value;
        if (!email || !password) return showAuthError('Введите email и пароль');

        try {
            const data = await api('POST', '/api/auth/login', { email, password });
            authToken = data.token;
            currentUser = data.user;
            localStorage.setItem('tinywin_token', authToken);
            if (!currentUser.is_verified) {
                showVerifyScreen(email);
            } else {
                onAuthSuccess();
            }
        } catch (e) {
            showAuthError(e.message);
        }
    }

    async function doRegister() {
        const email = $('#auth-email').value.trim();
        const password = $('#auth-password').value;
        if (!email || !password) return showAuthError('Введите email и пароль');
        if (password.length < 6) return showAuthError('Пароль минимум 6 символов');

        try {
            const data = await api('POST', '/api/auth/register', { email, password });
            authToken = data.token;
            currentUser = data.user;
            localStorage.setItem('tinywin_token', authToken);
            // Go to verification screen instead of splash
            showVerifyScreen(email);
        } catch (e) {
            showAuthError(e.message);
        }
    }

    // ===================== Email Verification =====================
    function showVerifyScreen(email) {
        $('#verify-subtitle').textContent = `Код отправлен на ${email}`;
        $('#verify-code').value = '';
        const errEl = $('#verify-error');
        if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
        switchScreen('verify');
        setTimeout(() => $('#verify-code').focus(), 300);
    }

    function showVerifyError(msg) {
        const el = $('#verify-error');
        el.textContent = msg;
        el.style.display = '';
    }

    async function doVerify() {
        const code = $('#verify-code').value.trim();
        if (!code || code.length !== 6) return showVerifyError('Введите 6-значный код');

        try {
            const data = await api('POST', '/api/auth/verify', {
                email: currentUser.email,
                code: code,
            });
            authToken = data.token;
            currentUser = data.user;
            localStorage.setItem('tinywin_token', authToken);
            onAuthSuccess();
        } catch (e) {
            showVerifyError(e.message || 'Неверный код');
        }
    }

    async function doResend() {
        try {
            await api('POST', '/api/auth/resend', { email: currentUser.email });
            $('#verify-subtitle').textContent = `Новый код отправлен на ${currentUser.email}`;
            const errEl = $('#verify-error');
            if (errEl) errEl.style.display = 'none';
        } catch (e) {
            showVerifyError(e.message || 'Ошибка отправки');
        }
    }

    function doLogout() {
        authToken = null;
        currentUser = null;
        isGuest = false;
        localStorage.removeItem('tinywin_token');
        $('#settings-panel').style.display = 'none';
        switchScreen('auth');
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
                setTimeout(() => startTask(extractTask(transcript)), 800);
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
        saveAll();
        switchScreen('decompose');
        runDecompose(taskName);
    }

    async function runDecompose(taskName) {
        $('#thinking-animation').style.display = '';
        $('#decompose-title').textContent = 'ИИ разбирает задачу...';
        $('#decompose-subtitle').textContent = `«${taskName}»`;
        $('#decompose-ready').style.display = 'none';
        $('#decompose-error').style.display = 'none';

        try {
            let steps;
            if (!isGuest && authToken) {
                // Authenticated — call backend API
                const data = await api('POST', '/api/ai/decompose', { task: taskName });
                steps = data.steps;
            } else {
                // Guest — use generic fallback
                steps = emergencyFallback(taskName);
                await new Promise((r) => setTimeout(r, 1200)); // fake delay
            }

            state.steps = steps;
            saveAll();

            $('#thinking-animation').style.display = 'none';
            $('#decompose-title').textContent = 'Готово!';
            $('#decompose-subtitle').textContent = `${steps.length} микро-шагов — справишься!`;
            $('#decompose-ready').style.display = '';

            const readyText = $('#decompose-ready .ready-text');
            if (readyText) readyText.textContent = `ИИ разбил задачу на ${steps.length} простых шагов.`;
        } catch (err) {
            if (err.message === 'LIMIT') return; // paywall shown
            console.error('AI decompose error:', err);
            $('#thinking-animation').style.display = 'none';
            $('#decompose-title').textContent = 'Ой, не получилось';
            $('#decompose-subtitle').textContent = '';
            $('#decompose-ready').style.display = 'none';
            $('#decompose-error').style.display = '';
            const msg = err.message.length > 120 ? err.message.substring(0, 120) + '...' : err.message;
            $('#decompose-error-text').textContent = msg;
        }
    }

    function retryDecompose() {
        if (state.taskName) runDecompose(state.taskName);
    }

    function useFallbackSteps() {
        const steps = emergencyFallback(state.taskName || 'Навести порядок');
        state.steps = steps;
        saveAll();
        $('#thinking-animation').style.display = 'none';
        $('#decompose-title').textContent = 'Готово!';
        $('#decompose-subtitle').textContent = `${steps.length} базовых шагов`;
        $('#decompose-error').style.display = 'none';
        $('#decompose-ready').style.display = '';
        const readyText = $('#decompose-ready .ready-text');
        if (readyText) readyText.textContent = `Задача разбита на ${steps.length} базовых шагов.`;
    }

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
        saveLocalState();
    }

    function completeStep() {
        if (settings.haptic && navigator.vibrate) navigator.vibrate([50, 30, 80]);

        state.completedSteps++;
        state.microWins++;
        daily.totalMicroWins++;
        addArtPixel();
        saveLocalDaily();

        const stepEl = $('#focus-step-text');
        stepEl.classList.add('step-done');
        createSparkles();

        clearInterval(stepTimer);
        clearTimeout(stuckTimer);
        state.currentStepIndex++;
        saveAll();

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
        clearInterval(stepTimer);
        clearTimeout(stuckTimer);
        stopAmbient();
        $('#pause-done-count').textContent = state.completedSteps;
        switchScreen('pause');
        exitFullscreen();
        saveAll();
    }

    function resumeFromPause() {
        state.isPaused = false;
        saveAll();
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
        const stepEl = $('#focus-step-text');
        stepEl.textContent = 'ИИ дробит шаг...';
        stepEl.classList.remove('step-enter', 'step-done');

        let subSteps;
        try {
            if (!isGuest && authToken) {
                const data = await api('POST', '/api/ai/split', {
                    step: currentStep,
                    task_context: state.taskName,
                });
                subSteps = data.steps;
            } else {
                subSteps = [
                    `Просто подумай о том, чтобы ${currentStep.toLowerCase()}`,
                    'А теперь просто сделай первое движение',
                ];
            }
        } catch (err) {
            if (err.message === 'LIMIT') return;
            console.warn('Split failed:', err);
            subSteps = [
                `Просто подумай о том, чтобы ${currentStep.toLowerCase()}`,
                'А теперь просто сделай первое движение',
            ];
        }

        state.steps.splice(state.currentStepIndex, 1, ...subSteps);
        saveAll();
        updateFocusUI();
        resetStuckTimer();
    }

    function showComplete() {
        switchScreen('complete');
        const statsEl = $('#complete-stats');
        if (statsEl) {
            statsEl.innerHTML = `За сегодня ты совершил <strong class="text-primary">${daily.totalMicroWins}</strong> маленьких действий.<br><span style="font-weight:300;color:var(--text-300)">Маленькая победа ведет к большим свершениям.</span>`;
        }
        saveAll();
    }

    function clearTask() {
        state.taskName = null;
        state.steps = [];
        state.currentStepIndex = 0;
        state.completedSteps = 0;
        state.microWins = 0;
        state.startedAt = null;
        state.isPaused = false;
        clearInterval(stepTimer);
        clearTimeout(stuckTimer);
        stopAmbient();
        exitFullscreen();
        timerSeconds = 0;
        saveAll();
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
        saveLocalDaily();
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
        state.ambientPlaying ? stopAmbient() : startAmbient(settings.ambientType !== 'none' ? settings.ambientType : 'brown');
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
            label.textContent = { brown: 'Шум', rain: 'Дождь', ticking: 'Ритм' }[state.ambientType] || 'Играет';
        } else {
            btn.classList.remove('active');
            label.textContent = 'Тишина';
        }
    }

    // ===================== Bootstrap =====================
    document.addEventListener('DOMContentLoaded', init);
    window.addEventListener('beforeunload', () => { saveLocalState(); saveLocalDaily(); });
    window.addEventListener('resize', () => {
        const c = $('#sparkle-canvas');
        if (c) { c.width = window.innerWidth; c.height = window.innerHeight; }
    });
})();
