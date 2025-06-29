// ==UserScript==
// @name         크랙 채팅 백업
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  크랙 채팅 백업
// @author       말루웅
// @match        https://crack.wrtn.ai/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      contents-api.wrtn.ai
// ==/UserScript==

(function() {
    'use strict';

    const utils = {
        waitForElement: (selector, scope = document, timeout = 7000) => new Promise((resolve, reject) => {
            const el = scope.querySelector(selector);
            if (el) return resolve(el);
            let timeoutId = null;
            const observer = new MutationObserver(() => {
                const observedEl = scope.querySelector(selector);
                if (observedEl) {
                    if (timeoutId) clearTimeout(timeoutId);
                    observer.disconnect();
                    resolve(observedEl);
                }
            });
            if (timeout > 0) {
                timeoutId = setTimeout(() => {
                    observer.disconnect();
                    reject(new Error(`[waitForElement] 요소를 찾지 못했습니다 (시간 초과 ${timeout}ms): ${selector}`));
                }, timeout);
            }
            observer.observe(scope, { childList: true, subtree: true });
        }),
        decodeMongoDbTimestamp: (objectId) => {
            try { return new Date(parseInt(objectId.substring(0, 8), 16) * 1000); }
            catch (e) { return new Date(); }
        },
        formatDate: (dateString) => {
            const date = new Date(dateString);
            return isNaN(date.getTime()) ? '시간 정보 없음' : date.toLocaleString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
        },
        downloadFile: (content, filename, type) => {
            const blob = new Blob([content], { type: `${type};charset=utf-8` });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            a.click();
            URL.revokeObjectURL(a.href);
        },
        formatRawContent: (content) => {
            if (!content) return '';
            return content.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(paragraph => {
                let processed = paragraph.replace(/\*([^*]+)\*/g, '$1');
                processed = processed.replace(/\n/g, '<br>');
                return `<p>${processed}</p>`;
            }).join('');
        },
        getCleanText: (rawContent) => {
            if (!rawContent) return '';
            const formattedHtml = utils.formatRawContent(rawContent);
            const div = document.createElement('div');
            div.innerHTML = formattedHtml;
            return div.textContent || '';
        }
    };

    class ChatExtractor {
        getCookie(name) { const value = `; ${document.cookie}`; const parts = value.split(`; ${name}=`); if (parts.length === 2) return parts.pop().split(';').shift(); return null; };
        getAuthToken() { const token = this.getCookie('access_token'); if (!token) throw new Error("인증 토큰(access_token)을 쿠키에서 찾을 수 없습니다. 로그인이 되어 있는지 확인해주세요."); return token; };

        async fetchAllMessages(chatId) {
            const allMessages = [];
            let hasNext = true;
            let cursor = '';
            const token = this.getAuthToken();
            while (hasNext) {
                const apiUrl = `https://contents-api.wrtn.ai/character-chat/api/v2/chat-room/${chatId}/messages?limit=200${cursor ? `&cursor=${cursor}` : ''}`;
                try {
                    const data = await new Promise((resolve, reject) => {
                        GM_xmlhttpRequest({
                            method: "GET", url: apiUrl, headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" },
                            onload: res => {
                                if (res.status >= 200 && res.status < 300) {
                                    const json = JSON.parse(res.responseText);
                                    if (json.result === "SUCCESS" && json.data) resolve(json.data);
                                    else reject(new Error("API 응답 데이터 형식이 올바르지 않습니다."));
                                } else reject(new Error(`API 요청 실패 (상태 코드: ${res.status}).`));
                            },
                            onerror: error => reject(new Error(`API 요청 중 네트워크 오류가 발생했습니다.`))
                        });
                    });
                    if (data.list && data.list.length > 0) allMessages.push(...data.list);
                    if (data.nextCursor) { cursor = data.nextCursor; } else { hasNext = false; }
                } catch (error) { console.error("페이지 로딩 중 오류:", error); hasNext = false; }
            }
            return allMessages;
        }

        formatModelName(crackerModel = '', model = '') {
            let modelString = `${crackerModel || ''} (${model || ''})`.replace(' ()', '').trim();
            if (modelString.includes('gemini-2.5-flash-preview')) {
                modelString = modelString.replace(/-preview-[\w-]+:streamGenerateContent/g, '');
            }
            return modelString;
        }

        createMessageObject(msg, author, characterName) {
            return {
                _id: msg._id,
                author: author,
                avatar: author === '사용자' ? '' : (document.querySelector('.character_avatar img')?.src || ''),
                timestamp: utils.decodeMongoDbTimestamp(msg._id),
                model: author === '사용자' ? 'N/A' : this.formatModelName(msg.crackerModel, msg.model),
                content: msg.content,
                turnId: msg.turnId,
                parentTurnId: msg.parentTurnId,
                isDeleted: msg.isDeleted || false // 삭제 상태 추가
            };
        }

        async extractCurrentChatMessages(chatId) {
            const characterName = document.querySelector('p.css-1ijub34')?.textContent.trim() || '캐릭터';
            const allRawMsgs = await this.fetchAllMessages(chatId);

            if (allRawMsgs.length === 0) {
                return { characterName, messages: [], extractedAt: new Date().toISOString() };
            }

            const msgsByTurnId = new Map(allRawMsgs.map(m => [m.turnId, m]));
            const childrenByParentId = new Map();

            allRawMsgs.forEach(msg => {
                if (msg.parentTurnId && msgsByTurnId.has(msg.parentTurnId)) {
                    if (!childrenByParentId.has(msg.parentTurnId)) {
                        childrenByParentId.set(msg.parentTurnId, []);
                    }
                    childrenByParentId.get(msg.parentTurnId).push(msg);
                }
            });

            for (const children of childrenByParentId.values()) {
                children.sort((a, b) => utils.decodeMongoDbTimestamp(a._id) - utils.decodeMongoDbTimestamp(b._id));
            }

            let finalMessages = [];
            const processedTurnIds = new Set();

            const roots = allRawMsgs.filter(m => !m.parentTurnId || !msgsByTurnId.has(m.parentTurnId))
                .sort((a,b) => utils.decodeMongoDbTimestamp(a._id) - utils.decodeMongoDbTimestamp(b._id));

            roots.forEach(rootMsg => {
                let messageQueue = [rootMsg];

                while(messageQueue.length > 0) {
                    const currentMsg = messageQueue.shift();
                    if (processedTurnIds.has(currentMsg.turnId)) continue;

                    const author = currentMsg.role === 'user' ? '사용자' : characterName;
                    const messageObject = this.createMessageObject(currentMsg, author, characterName);

                    const children = childrenByParentId.get(currentMsg.turnId) || [];

                    if (author === '사용자' && children.length > 0) {
                        finalMessages.push(messageObject);
                        processedTurnIds.add(currentMsg.turnId);

                        const hasGrandchildren = children.some(c => childrenByParentId.has(c.turnId));
                        if(children.length > 1 && !hasGrandchildren) { // 대안 답변 그룹
                            const representativeMsg = this.createMessageObject(children[0], characterName);
                            representativeMsg.alternatives = children.map(c => this.createMessageObject(c, characterName));
                            finalMessages.push(representativeMsg);
                            children.forEach(c => processedTurnIds.add(c.turnId));
                        } else { // 일반 체인
                             messageQueue.unshift(...children);
                        }

                    } else {
                         finalMessages.push(messageObject);
                         processedTurnIds.add(currentMsg.turnId);
                         messageQueue.unshift(...children);
                    }
                }
            });

             return { characterName, messages: finalMessages, extractedAt: new Date().toISOString() };
        }
    }

    class BackupUI {
        constructor() {
            this.extractor = new ChatExtractor();
            this.chatId = null;
            this.longPressTimer = null;
            this.isLongPress = false;
            this.buttonState = 'default';
            this.refetchTimeout = null;
            this.init();
        }

        async init() {
            const observer = new MutationObserver(() => {
                const newChatId = this.getChatIdFromUrl();
                if (newChatId && newChatId !== this.chatId) { this.chatId = newChatId; this.addBackupButton(); }
                else if (!newChatId && this.chatId) { this.chatId = null; this.removeBackupButton(); }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            this.chatId = this.getChatIdFromUrl();
            if (this.chatId) this.addBackupButton();
        }

        getChatIdFromUrl() { const match = window.location.pathname.match(/\/c\/([^/]+)/); return match ? match[1] : null; }
        removeBackupButton() { const button = document.getElementById('oneClickBackupButton'); if (button) button.remove(); }

        addBackupButton() {
            if (!this.chatId) return; this.removeBackupButton();
            const fab = document.createElement('div'); fab.id = 'oneClickBackupButton';
            const defaultBg = '#252525';
            fab.style.cssText = `position:fixed;bottom:25px;right:25px;width:60px;height:60px;background-color:${defaultBg};color:white;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:28px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.3);z-index:9999;transition:all 0.2s ease-in-out;-webkit-user-select: none; -moz-user-select: none; -ms-user-select: none; user-select: none;`;
            fab.innerHTML = '🩵'; fab.title = '짧게 클릭: 백업\n길게 누르기: 관리 & 색상 설정';
            this.buttonState = 'default';

            const resetButtonStyle = () => {
                fab.style.transform = 'scale(1)';
                fab.style.backgroundColor = defaultBg;
                fab.style.backgroundImage = 'none';
                if (this.buttonState !== 'refetch') {
                    fab.innerHTML = '🩵';
                }
            };

            fab.addEventListener('mousedown', (e) => {
                if (e.button !== 0 || fab.disabled) return;
                clearTimeout(this.refetchTimeout);
                this.isLongPress = false;
                fab.style.transition = 'all 0.1s ease-in-out'; fab.style.transform = 'scale(0.9)';
                this.longPressTimer = setTimeout(() => {
                    this.isLongPress = true;
                    fab.innerHTML = '⚙️'; fab.style.background = 'linear-gradient(45deg, #888, #555)';
                    if (confirm('설정 창을 여시겠습니까?')) {
                        this.showManagementModal();
                    }
                    resetButtonStyle();
                }, 500);
            });

            fab.addEventListener('mouseup', (e) => {
                if (e.button !== 0 || fab.disabled) return;
                clearTimeout(this.longPressTimer);
                if (!this.isLongPress) {
                    if (this.buttonState === 'refetch') {
                        this.buttonState = 'default';
                        this.runBackup(true);
                    } else {
                        this.runBackup(false);
                    }
                }
                if (!fab.disabled) resetButtonStyle();
            });
            fab.addEventListener('mouseleave', () => {
                if(fab.disabled) return;
                clearTimeout(this.longPressTimer);
                if(!this.isLongPress) resetButtonStyle();
            });

            document.body.appendChild(fab);
        }

        async runBackup(force = false) {
            const backupButton = document.getElementById('oneClickBackupButton');
            if (!backupButton || backupButton.disabled) return;

            const defaultIcon = '🩵';
            const refetchIcon = '🔄️';
            const chatKey = `wrtn_backup_${this.chatId}`;

            const setButtonState = (icon, title, disabled) => {
                backupButton.innerHTML = icon; backupButton.title = title; backupButton.disabled = disabled;
                backupButton.style.cursor = disabled ? 'default' : 'pointer';
                if (!disabled) { backupButton.style.transform = 'scale(1)'; }
            };

            setButtonState('...', '백업 중...', true);
            backupButton.style.transform = 'scale(0.9)';

            try {
                const colorSettings = this.getColorSettings();
                let currentChatData = await this.extractor.extractCurrentChatMessages(this.chatId);

                if (force) {
                    const finalData = { ...currentChatData, extractedAt: new Date().toISOString() };
                    GM_setValue(chatKey, JSON.stringify(finalData));
                    const fileContent = this.generateHTML(finalData, colorSettings);
                    const filename = `wrtn_crack_chat_${finalData.characterName}_(전체 재백업).html`;
                    utils.downloadFile(fileContent, filename, 'text/html');
                    setButtonState('✅', '강제 백업 완료!', true);
                    setTimeout(() => setButtonState(defaultIcon, '짧게 클릭: 백업\n길게 누르기: 관리 & 색상 설정', false), 2000);
                } else {
                    const savedData = JSON.parse(GM_getValue(chatKey, null)) || { messages: [] };

                    const savedMessagesMap = new Map();
                    if(savedData && savedData.messages){
                        const addAllToMap = (msgs) => {
                            for(const msg of msgs) {
                                savedMessagesMap.set(msg._id, msg);
                                if(msg.alternatives) addAllToMap(msg.alternatives);
                            }
                        };
                        addAllToMap(savedData.messages);
                    }

                    const mergeAll = (msgs) => {
                        for(const msg of msgs) {
                            if(savedMessagesMap.has(msg._id)) {
                                msg.isDeleted = savedMessagesMap.get(msg._id).isDeleted;
                            }
                            if(msg.alternatives) mergeAll(msg.alternatives);
                        }
                    };
                    mergeAll(currentChatData.messages);


                    const stringifyForCompare = (data) => JSON.stringify(data, (key, value) => key === 'isDeleted' || key === 'extractedAt' ? undefined : value);
                    const hasChanges = stringifyForCompare(savedData) !== stringifyForCompare(currentChatData);

                    if (hasChanges) {
                        const finalData = { ...currentChatData, extractedAt: new Date().toISOString() };
                        GM_setValue(chatKey, JSON.stringify(finalData));
                        const fileContent = this.generateHTML(finalData, colorSettings);
                        const filename = `wrtn_crack_chat_${finalData.characterName}_(통합본).html`;
                        utils.downloadFile(fileContent, filename, 'text/html');
                        setButtonState('✅', '백업 완료!', true);
                        setTimeout(() => setButtonState(defaultIcon, '짧게 클릭: 백업\n길게 누르기: 관리 & 색상 설정', false), 2000);
                    } else {
                        this.buttonState = 'refetch';
                        setButtonState(refetchIcon, '변경점 없음. 클릭하여 강제로 다시 받기', false);
                        this.refetchTimeout = setTimeout(() => {
                            if (this.buttonState === 'refetch') {
                                this.buttonState = 'default';
                                setButtonState(defaultIcon, '짧게 클릭: 백업\n길게 누르기: 관리 & 색상 설정', false);
                            }
                        }, 2000);
                    }
                }
            } catch (error) {
                alert(`백업 오류가 발생했습니다: ${error.message}`);
                console.error("백업 실패:", error);
                setButtonState('⚠️', error.message, true);
                setTimeout(() => setButtonState(defaultIcon, '짧게 클릭: 백업\n길게 누르기: 관리 & 색상 설정', false), 2000);
            }
        }

        async runMergeBackup() {
            alert('병합 백업을 시작합니다...');
            try {
                const chatKey = `wrtn_backup_${this.chatId}`;
                const colorSettings = this.getColorSettings();

                const savedData = JSON.parse(GM_getValue(chatKey, null)) || { messages: [] };
                const savedMessagesMap = new Map();
                const addSavedToMap = (msgs) => {
                    for (const msg of msgs) {
                        savedMessagesMap.set(msg._id, msg);
                        if (msg.alternatives) addSavedToMap(msg.alternatives);
                    }
                };
                if (savedData.messages) addSavedToMap(savedData.messages);

                const currentChatData = await this.extractor.extractCurrentChatMessages(this.chatId);

                const finalMessages = [...currentChatData.messages];
                const currentIds = new Set(Array.from(finalMessages.flatMap(msg => msg.alternatives ? [msg, ...msg.alternatives] : [msg])).map(m => m._id));

                if (savedData.messages) {
                    const processSaved = (msgs) => {
                        for (const sMsg of msgs) {
                            if (!currentIds.has(sMsg._id)) {
                                finalMessages.push(sMsg);
                            }
                            if (sMsg.alternatives) {
                                for (const sAlt of sMsg.alternatives) {
                                    if (!currentIds.has(sAlt._id)) {
                                        finalMessages.push(sAlt);
                                    }
                                }
                            }
                        }
                    };
                    processSaved(savedData.messages);
                }

                const mergeDeletedStatus = (msgs) => {
                    for(const msg of msgs){
                        if(savedMessagesMap.has(msg._id)){
                            msg.isDeleted = savedMessagesMap.get(msg._id).isDeleted;
                        }
                        if(msg.alternatives) mergeDeletedStatus(msg.alternatives);
                    }
                };
                mergeDeletedStatus(finalMessages);

                finalMessages.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));

                const finalData = {
                    characterName: currentChatData.characterName,
                    messages: finalMessages,
                    extractedAt: new Date().toISOString()
                };

                GM_setValue(chatKey, JSON.stringify(finalData));
                const fileContent = this.generateHTML(finalData, colorSettings);
                const filename = `wrtn_crack_chat_${finalData.characterName}_(병합백업).html`;
                utils.downloadFile(fileContent, filename, 'text/html');
                alert('병합 백업 파일 다운로드가 완료되었습니다.');

                const modal = document.getElementById('backupManagementModal');
                if (modal) modal.remove();
                this.showManagementModal();

            } catch (error) {
                alert(`병합 백업 중 오류가 발생했습니다: ${error.message}`);
                console.error("병합 백업 실패:", error);
            }
        }

        getColorSettings() {
            const defaults = { backgroundColor: "#1a1a1a", textColor: "#ffffff", authorNameColor: "#ffffff", metaTextColor: "#bababa", userBubble: "#adc6ff", modelColors: { DEFAULT: "#2a2a2a", OPUS4: "#F4B6C2", SONNET4: "#C9B3F4", SONNET3_7: "#A3D8F4", SONNET3_5: "#c9ecf8", GEMINI2_5FLASH: "#9FE2BF", HAIKU: "#FFD54F" } };
            const saved = JSON.parse(GM_getValue('wrtn_backup_colors', JSON.stringify(defaults)));
            return { ...defaults, ...saved, modelColors: {...defaults.modelColors, ...(saved.modelColors || {})}};
        }

        showManagementModal() {
            const oldModal = document.getElementById('backupManagementModal'); if (oldModal) oldModal.remove();
            const chatKey = `wrtn_backup_${this.chatId}`;
            let savedData = JSON.parse(GM_getValue(chatKey, null)) || { messages: [] };
            const currentColors = this.getColorSettings();

            const modal = document.createElement('div'); modal.id = 'backupManagementModal';
            modal.innerHTML = `
                <style>
                    #backupManagementModal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 90%; max-width: 800px; height: 90%; max-height: 800px; z-index: 10000; }
                    .modal-content { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #2c2c2c; color: white; width: 100%; height: 100%; border-radius: 10px; box-shadow: 0 5px 20px rgba(0,0,0,0.4); display: flex; flex-direction: column; font-size: 14px; }
                    .modal-header { padding: 15px 20px; font-size: 1.1em; font-weight: bold; border-bottom: 1px solid #444; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; cursor: move; }
                    .modal-header .title { flex-grow: 1; pointer-events: none; }
                    .modal-header .btn { background-color: #444; color: white; border: 1px solid #555; border-radius: 5px; padding: 5px 10px; cursor: pointer; margin-left: 10px; }
                    .modal-header .btn-close { background: none; border: none; font-size: 1.8em; line-height: 1; padding: 0 5px; }
                    .modal-body-wrapper { display: flex; flex-direction: column; flex-grow: 1; overflow: hidden; }
                    .modal-tabs { flex-shrink: 0; border-bottom: 1px solid #444; padding: 0 15px; }
                    .tab-btn { background: none; border: none; color: #aaa; padding: 10px 15px; cursor: pointer; font-size: 1em; border-bottom: 2px solid transparent; }
                    .tab-btn.active { color: white; border-bottom-color: #8c9eff; }
                    .tab-content { display: none; flex-grow: 1; overflow: auto; padding: 5px 20px; }
                    .tab-content.active { display: block; }
                    .list-item { padding: 10px; border-bottom: 1px solid #444; display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
                    .list-item.alt { padding-left: 25px; border-bottom-style: dashed; border-color: #555; }
                    .list-item-content { flex-grow: 1; word-break: break-word; }
                    .list-item .author { font-weight: bold; margin-right: 8px; }
                    .list-item .text-preview { white-space: pre-wrap; line-height: 1.5; color: #ddd; max-height: 3.2em; overflow: hidden; transition: max-height 0.25s ease-out; }
                    .list-item .text-preview.expanded { max-height: 200px; overflow-y: auto; }
                    .list-item .expand-btn { color: #8c9eff; cursor: pointer; font-size: 0.9em; margin-top: 5px; display: block; }
                    .delete-btn { background: none; border: none; cursor: pointer; font-size: 1.2em; padding: 5px; }
                    .restore-btn { background: #4caf50; border: none; cursor: pointer; color: white; padding: 3px 8px; border-radius: 4px; font-size: 0.9em; }
                    .settings-container-wrapper { padding: 15px 20px; }
                    .settings-section h3 { margin-top: 0; margin-bottom: 15px; border-bottom: 1px solid #555; padding-bottom: 8px; font-size: 1em; }
                    .color-setting { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
                    .color-setting label { font-size: 0.95em; flex-shrink: 0; margin-right: 10px; }
                    .color-input-wrapper { display: flex; align-items: center; gap: 5px; }
                    .color-setting input[type="color"] { width: 25px; height: 25px; border: 1px solid #555; padding: 0; background: none; cursor: pointer; border-radius: 4px; }
                    .color-setting input[type="text"] { width: 70px; background-color: #333; border: 1px solid #555; color: white; border-radius: 4px; padding: 3px 5px; font-family: monospace; }
                    .paste-hex-btn { font-size: 11px; padding: 4px 6px; background-color: #555; border: 1px solid #666; border-radius: 4px; cursor: pointer; }
                </style>
                <div class="modal-content">
                    <div class="modal-header">
                        <span class="title">설정</span>
                        <div>
                            <button class="btn" id="mergeBackupBtn" title="채팅 삭제나 복구 후, 이 버튼을 눌러야 활성화가 됩니다.">새 내용 병합</button>
                            <button class="btn" id="exportTxtBtn" title="백업된 내용을 텍스트 문서로 저장합니다.">TXT</button>
                            <button class="btn btn-close" id="closeModalBtn">×</button>
                        </div>
                    </div>
                    <div class="modal-body-wrapper">
                        <div class="modal-tabs">
                            <button class="tab-btn active" data-tab="backup">백업 목록</button>
                            <button class="tab-btn" data-tab="deleted">삭제된 항목</button>
                            <button class="tab-btn" data-tab="settings">색상 설정</button>
                        </div>
                        <div id="tab-backup" class="tab-content active"></div>
                        <div id="tab-deleted" class="tab-content"></div>
                        <div id="tab-settings" class="tab-content"></div>
                    </div>
                </div>`;
            document.body.appendChild(modal);
            this.makeDraggable(modal, modal.querySelector('.modal-header'));

            modal.querySelector('#mergeBackupBtn').addEventListener('click', () => this.runMergeBackup());

            const updateItemDeletedState = (msgId, isDeleted) => {
                let found = false;
                function findAndMark(messages) {
                    if (found || !messages) return;
                    for (const msg of messages) {
                        if (msg._id === msgId) {
                            msg.isDeleted = isDeleted;
                            found = true;
                            return;
                        }
                        if (msg.alternatives) {
                            findAndMark(msg.alternatives);
                        }
                    }
                }
                findAndMark(savedData.messages);
                GM_setValue(chatKey, JSON.stringify(savedData));
                renderAllLists();
            };

            const createListItem = (item, isAlt, isDeletedList) => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'list-item' + (isAlt ? ' alt' : '');

                const contentDiv = document.createElement('div');
                contentDiv.className = 'list-item-content';

                const authorSpan = document.createElement('span');
                authorSpan.className = 'author';
                authorSpan.style.color = item.author === '사용자' ? '#a5d8ff' : '#fcc2d7';
                authorSpan.textContent = `${isAlt ? '↳ ' : ''}${item.author.replace(/\n/g, '')}:`;

                const textDiv = document.createElement('div');
                textDiv.className = 'text-preview';
                textDiv.textContent = utils.getCleanText(item.content);

                contentDiv.appendChild(authorSpan);
                contentDiv.appendChild(textDiv);

                setTimeout(() => {
                    try {
                        if (textDiv.parentElement && textDiv.scrollHeight > textDiv.clientHeight) {
                            const expandBtn = document.createElement('span');
                            expandBtn.className = 'expand-btn';
                            expandBtn.textContent = '[더 보기]';
                            expandBtn.onclick = (e) => {
                                e.stopPropagation();
                                textDiv.classList.toggle('expanded');
                                expandBtn.textContent = textDiv.classList.contains('expanded') ? '[접기]' : '[더 보기]';
                            };
                            contentDiv.appendChild(expandBtn);
                        }
                    } catch (e) {
                        // Ignore errors
                    }
                }, 0);

                itemDiv.appendChild(contentDiv);

                const actionButton = document.createElement('button');
                if (isDeletedList) {
                    actionButton.className = 'restore-btn';
                    actionButton.textContent = '복구';
                    actionButton.onclick = () => updateItemDeletedState(item._id, false);
                } else {
                    actionButton.className = 'delete-btn';
                    actionButton.innerHTML = '❌';
                    actionButton.onclick = () => updateItemDeletedState(item._id, true);
                }
                itemDiv.appendChild(actionButton);
                return itemDiv;
            };

            const renderList = (container, isDeletedList) => {
                container.innerHTML = `<h4>${isDeletedList ? '삭제된 항목' : ((savedData && savedData.characterName) ? savedData.characterName.replace(/\n/g, '') : '백업') + ' 기록'}</h4>`;
                let hasContent = false;

                if (savedData && savedData.messages) {
                    const processMessages = (messages) => {
                        for (const msg of messages) {
                            if (msg.isDeleted === isDeletedList) {
                                hasContent = true;
                                if (!msg.alternatives) {
                                    container.appendChild(createListItem(msg, false, isDeletedList));
                                }
                            }

                            if (msg.alternatives) {
                                for (const alt of msg.alternatives) {
                                    if (alt.isDeleted === isDeletedList) {
                                        hasContent = true;
                                        container.appendChild(createListItem(alt, true, isDeletedList));
                                    }
                                }
                            }
                        }
                    };
                    processMessages(savedData.messages);
                }

                if (!hasContent) {
                    container.innerHTML += `<p style="text-align:center; padding: 20px; color: #888;">${isDeletedList ? '삭제된 항목이' : '표시할 메시지가'} 없습니다.</p>`;
                }
            };

            const renderAllLists = () => {
                // <<<<<<<<<<<< [최종 버그 수정] 불필요한 데이터 재로딩 코드를 삭제하여 상태 불일치 문제 해결
                // savedData = JSON.parse(GM_getValue(chatKey, null)) || { messages: [] };
                renderList(modal.querySelector('#tab-backup'), false);
                renderList(modal.querySelector('#tab-deleted'), true);
                modal.querySelector('#exportTxtBtn').disabled = !savedData || !savedData.messages || savedData.messages.length === 0;
            };

            const settingsContainer = modal.querySelector('#tab-settings');
            settingsContainer.innerHTML = `
                 <div class="settings-container-wrapper">
                      <div class="settings-section"><h3>색상 설정</h3>
                           <div class="color-setting"><label>바탕 색깔</label><div class="color-input-wrapper"><input type="color" data-hex-target="bgColorHex" value="${currentColors.backgroundColor}"><input type="text" id="bgColorHex" value="${currentColors.backgroundColor}"><button class="paste-hex-btn" data-target="bgColorHex">붙여넣기</button></div></div>
                           <div class="color-setting"><label>기본 텍스트</label><div class="color-input-wrapper"><input type="color" data-hex-target="textColorHex" value="${currentColors.textColor}"><input type="text" id="textColorHex" value="${currentColors.textColor}"><button class="paste-hex-btn" data-target="textColorHex">붙여넣기</button></div></div>
                           <div class="color-setting"><label>캐릭터 이름</label><div class="color-input-wrapper"><input type="color" data-hex-target="authorNameColorHex" value="${currentColors.authorNameColor}"><input type="text" id="authorNameColorHex" value="${currentColors.authorNameColor}"><button class="paste-hex-btn" data-target="authorNameColorHex">붙여넣기</button></div></div>
                           <div class="color-setting"><label>메타 정보</label><div class="color-input-wrapper"><input type="color" data-hex-target="metaTextColorHex" value="${currentColors.metaTextColor}"><input type="text" id="metaTextColorHex" value="${currentColors.metaTextColor}"><button class="paste-hex-btn" data-target="metaTextColorHex">붙여넣기</button></div></div>
                           <div class="color-setting"><label>사용자 말풍선</label><div class="color-input-wrapper"><input type="color" data-hex-target="userBubbleColorHex" value="${currentColors.userBubble}"><input type="text" id="userBubbleColorHex" value="${currentColors.userBubble}"><button class="paste-hex-btn" data-target="userBubbleColorHex">붙여넣기</button></div></div>
                      </div>
                      <div class="settings-section"><h3>모델별 색상 설정</h3>
                           <div class="color-setting"><label>OPUS 4</label><div class="color-input-wrapper"><input type="color" data-hex-target="color_opus4_h" value="${currentColors.modelColors.OPUS4}"><input type="text" id="color_opus4_h" value="${currentColors.modelColors.OPUS4}"><button class="paste-hex-btn" data-target="color_opus4_h">붙여넣기</button></div></div>
                           <div class="color-setting"><label>SONNET 4</label><div class="color-input-wrapper"><input type="color" data-hex-target="color_sonnet4_h" value="${currentColors.modelColors.SONNET4}"><input type="text" id="color_sonnet4_h" value="${currentColors.modelColors.SONNET4}"><button class="paste-hex-btn" data-target="color_sonnet4_h">붙여넣기</button></div></div>
                           <div class="color-setting"><label>SONNET 3.7</label><div class="color-input-wrapper"><input type="color" data-hex-target="color_sonnet37_h" value="${currentColors.modelColors.SONNET3_7}"><input type="text" id="color_sonnet37_h" value="${currentColors.modelColors.SONNET3_7}"><button class="paste-hex-btn" data-target="color_sonnet37_h">붙여넣기</button></div></div>
                           <div class="color-setting"><label>SONNET 3.5</label><div class="color-input-wrapper"><input type="color" data-hex-target="color_sonnet35_h" value="${currentColors.modelColors.SONNET3_5}"><input type="text" id="color_sonnet35_h" value="${currentColors.modelColors.SONNET3_5}"><button class="paste-hex-btn" data-target="color_sonnet35_h">붙여넣기</button></div></div>
                           <div class="color-setting"><label>GEMINI FLASH</label><div class="color-input-wrapper"><input type="color" data-hex-target="color_gemini_h" value="${currentColors.modelColors.GEMINI2_5FLASH}"><input type="text" id="color_gemini_h" value="${currentColors.modelColors.GEMINI2_5FLASH}"><button class="paste-hex-btn" data-target="color_gemini_h">붙여넣기</button></div></div>
                           <div class="color-setting"><label>HAIKU</label><div class="color-input-wrapper"><input type="color" data-hex-target="color_haiku_h" value="${currentColors.modelColors.HAIKU}"><input type="text" id="color_haiku_h" value="${currentColors.modelColors.HAIKU}"><button class="paste-hex-btn" data-target="color_haiku_h">붙여넣기</button></div></div>
                           <div class="color-setting"><label>기타 모델</label><div class="color-input-wrapper"><input type="color" data-hex-target="color_default_h" value="${currentColors.modelColors.DEFAULT}"><input type="text" id="color_default_h" value="${currentColors.modelColors.DEFAULT}"><button class="paste-hex-btn" data-target="color_default_h">붙여넣기</button></div></div>
                      </div>
                      <button class="btn" id="saveColorSettingsBtn" style="width: 100%; padding: 10px; margin-top: 10px;">설정 저장</button>
                 </div>`;

            modal.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', (e) => {
                modal.querySelector('.tab-btn.active').classList.remove('active');
                modal.querySelector('.tab-content.active').classList.remove('active');
                e.target.classList.add('active');
                modal.querySelector(`#tab-${e.target.dataset.tab}`).classList.add('active');
            }));

            renderAllLists();

            modal.querySelector('#exportTxtBtn').onclick = () => { const textContent = this.generatePlainText(savedData); utils.downloadFile(textContent, `wrtn_crack_chat_${savedData.characterName.replace(/\n/g, '')}_(텍스트).txt`, 'text/plain'); };
            modal.querySelector('#closeModalBtn').onclick = () => modal.remove();

            modal.querySelectorAll('.color-input-wrapper').forEach(wrapper => {
                const picker = wrapper.querySelector('input[type="color"]');
                const hexInput = wrapper.querySelector('input[type="text"]');
                const pasteBtn = wrapper.querySelector('.paste-hex-btn');
                picker.addEventListener('input', () => hexInput.value = picker.value);
                hexInput.addEventListener('input', () => { if (/^#[0-9A-F]{6}$/i.test(hexInput.value)) { picker.value = hexInput.value; } });
                pasteBtn.addEventListener('click', async () => {
                    try {
                        const text = await navigator.clipboard.readText();
                        if (/^#[0-9A-F]{6}$/i.test(text)) {
                            hexInput.value = text;
                            picker.value = text;
                        } else { alert('붙여넣기 실패: 유효한 헥스 코드 형식이 아닙니다 (#RRGGBB)'); }
                    } catch (err) { console.error('클립보드 읽기 실패:', err); alert('클립보드 읽기에 실패했습니다. 브라우저의 권한 설정을 확인해주세요.'); }
                });
            });

            modal.querySelector('#saveColorSettingsBtn').onclick = () => {
                const newColors = {
                    backgroundColor: modal.querySelector('#bgColorHex').value, textColor: modal.querySelector('#textColorHex').value, authorNameColor: modal.querySelector('#authorNameColorHex').value, metaTextColor: modal.querySelector('#metaTextColorHex').value, userBubble: modal.querySelector('#userBubbleColorHex').value,
                    modelColors: { OPUS4: modal.querySelector('#color_opus4_h').value, SONNET4: modal.querySelector('#color_sonnet4_h').value, SONNET3_7: modal.querySelector('#color_sonnet37_h').value, SONNET3_5: modal.querySelector('#color_sonnet35_h').value, GEMINI2_5FLASH: modal.querySelector('#color_gemini_h').value, HAIKU: modal.querySelector('#color_haiku_h').value, DEFAULT: modal.querySelector('#color_default_h').value, }
                };
                GM_setValue('wrtn_backup_colors', JSON.stringify(newColors));
                alert('색상 설정이 저장되었습니다.');
            };
        }

        makeDraggable(element, handle) {
            let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
            handle.onmousedown = dragMouseDown;
            function dragMouseDown(e) { e = e || window.event; e.preventDefault(); pos3 = e.clientX; pos4 = e.clientY; document.onmouseup = closeDragElement; document.onmousemove = elementDrag; }
            function elementDrag(e) { e = e || window.event; e.preventDefault(); pos1 = pos3 - e.clientX; pos2 = pos4 - e.clientY; pos3 = e.clientX; pos4 = e.clientY; element.style.top = (element.offsetTop - pos2) + "px"; element.style.left = (element.offsetLeft - pos1) + "px"; element.style.transform = ''; }
            function closeDragElement() { document.onmouseup = null; document.onmousemove = null; }
        }

        generatePlainText(data) {
            const lines = [];
            lines.push(`대화 상대: ${data.characterName.replace(/\n/g, '')}`);
            lines.push(`백업 일시: ${utils.formatDate(new Date(data.extractedAt))}`);
            lines.push('---');

            function processMessages(messages) {
                if (!messages) return;
                messages.forEach(msg => {
                    if (msg.isDeleted) return;

                    const author = msg.author.replace(/\n/g, '');
                    const cleanContent = utils.getCleanText(msg.content);

                    if (msg.alternatives) {
                        const visibleAlts = msg.alternatives.filter(alt => !alt.isDeleted);
                        if (visibleAlts.length > 0) {
                            const firstAlt = visibleAlts[0];
                             lines.push(`[${utils.formatDate(new Date(firstAlt.timestamp))}] ${firstAlt.author.replace(/\n/g, '')}:\n${utils.getCleanText(firstAlt.content)}`);

                            if (visibleAlts.length > 1) {
                                let altDisplayIndex = 1;
                                visibleAlts.slice(1).forEach((alt) => {
                                    lines.push(`↳ 대안 답변 ${altDisplayIndex++}: ${utils.getCleanText(alt.content)}`);
                                });
                            }
                             lines.push('');
                        }
                    } else {
                         lines.push(`[${utils.formatDate(new Date(msg.timestamp))}] ${author}:\n${cleanContent}`);
                         lines.push('');
                    }
                });
            }
            if (data.messages) processMessages(data.messages);
            return lines.join('\n').replace(/\n\n\n/g, '\n\n');
        }

        generateHTML(data, colorSettings) {
            const getModelColor = (modelName = '') => {
                const upperModel = (modelName || '').toUpperCase();
                if (upperModel.includes('OPUS')) return colorSettings.modelColors.OPUS4;
                if (upperModel.includes('SONNET') && upperModel.includes('4')) return colorSettings.modelColors.SONNET4;
                if (upperModel.includes('SONNET') && upperModel.includes('3.7')) return colorSettings.modelColors.SONNET3_7;
                if (upperModel.includes('SONNET') && upperModel.includes('3.5')) return colorSettings.modelColors.SONNET3_5;
                if (upperModel.includes('GEMINI')) return colorSettings.modelColors.GEMINI2_5FLASH;
                if (upperModel.includes('HAIKU')) return colorSettings.modelColors.HAIKU;
                if (upperModel.includes('SONNET')) return colorSettings.modelColors.SONNET3_7;
                return colorSettings.modelColors.DEFAULT;
            };

            const processContent = (rawContent) => { if (!rawContent) return ''; let formatted = utils.formatRawContent(rawContent); return formatted.replace(/!\[.*?\]\((.*?)\)/g, '<img src="$1" alt="chat-image" class="chat-image">'); };

            let messagesHtml = '';
            const processedIds = new Set();

            function renderMessages(messages) {
                let html = '';
                if (!messages) return html;
                for (const msg of messages) {
                    if (processedIds.has(msg._id) || msg.isDeleted) continue;

                    let messageBlock = '';
                    const avatarHtml = msg.avatar ? `<img src="${msg.avatar}" alt="av" class="avatar">` : `<div class="avatar default-avatar"></div>`;

                    if (msg.alternatives) {
                        const visibleAlts = msg.alternatives.filter(alt => !alt.isDeleted);
                        if (visibleAlts.length > 0) {
                            const firstAltAvatar = visibleAlts[0].avatar ? `<img src="${visibleAlts[0].avatar}" alt="av" class="avatar">` : `<div class="avatar default-avatar"></div>`;
                            const buttonsHtml = visibleAlts.map((_, altIndex) => `<button class="alt-btn" data-alt-idx="${altIndex}">${altIndex + 1}</button>`).join('');
                            const contentsHtml = visibleAlts.map((alt, altIndex) => {
                                const altModelColor = getModelColor(alt.model);
                                return `<div class="answer-content" data-answer-id="${altIndex}" style="display:${altIndex === 0 ? 'block' : 'none'}; --ai-bubble-color: ${altModelColor};"><div class="author-header"><span class="author-name">${alt.author}</span><span class="message-meta">${utils.formatDate(new Date(alt.timestamp))} • ${alt.model || 'N/A'}</span></div><div class="message-content" style="background-color: ${altModelColor}; color: #000;">${processContent(alt.content)}</div></div>`;
                            }).join('');
                            const firstAltModelColor = getModelColor(visibleAlts[0].model);
                            const contentHtml = `<div class="interactive-message">${contentsHtml}<div class="alt-controls"><b>답변 선택: </b>${buttonsHtml}</div></div>`;
                            messageBlock = `<div class="message ai" style="--ai-bubble-color: ${firstAltModelColor};">${firstAltAvatar}<div class="message-body">${contentHtml}</div></div>`;

                            processedIds.add(msg._id);
                            msg.alternatives.forEach(alt => processedIds.add(alt._id));
                        }
                    } else {
                        const modelColor = getModelColor(msg.model);
                        const authorHeader = msg.author === '사용자' ? `<div class="author-header user"><span class="message-meta">${utils.formatDate(new Date(msg.timestamp))}</span></div>` : `<div class="author-header"><span class="author-name">${msg.author}</span><span class="message-meta">${utils.formatDate(new Date(msg.timestamp))} • ${msg.model || 'N/A'}</span></div>`;
                        const contentHtml = `<div class="content-text">${processContent(msg.content)}</div>`;
                        const bubbleColor = msg.author === '사용자' ? 'var(--user-bubble-color)' : modelColor;
                        const textColor = msg.author === '사용자' ? '#1a1a1a' : '#000';
                        messageBlock = `<div class="message ${msg.author === '사용자' ? 'user' : 'ai'}">${msg.author !== '사용자' ? avatarHtml : ''}<div class="message-body">${authorHeader}<div class="message-content" style="background-color: ${bubbleColor}; color: ${textColor};">${contentHtml}</div></div></div>`;
                        processedIds.add(msg._id);
                    }
                    html += messageBlock;
                }
                return html;
            }

            if (data.messages) {
                 messagesHtml = renderMessages(data.messages);
            }


            const visibleMessageCount = data.messages ? data.messages.reduce((count, msg) => {
                if (msg.isDeleted) return count;
                if (msg.alternatives) {
                    const visibleAlts = msg.alternatives.filter(a => !a.isDeleted).length;
                    return count + (visibleAlts > 0 ? 1 : 0);
                }
                return count + 1;
            }, 0) : 0;


            return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>${data.characterName} - 채팅 백업</title><style>
                  * { box-sizing: border-box; } :root { --bg-color: ${colorSettings.backgroundColor}; --text-color: ${colorSettings.textColor}; --user-bubble-color: ${colorSettings.userBubble}; --author-name-color: ${colorSettings.authorNameColor}; --meta-text-color: ${colorSettings.metaTextColor}; } body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; background-color: var(--bg-color); color: var(--text-color); } .container { max-width: 600px; margin: auto; padding: 20px; } .header { text-align: center; border-bottom: 1px solid #444; padding-bottom: 20px; margin-bottom: 30px; } h1 { margin: 0; color: #fff; } .meta-info { font-size: 0.9em; color: var(--meta-text-color); } .message { display: flex; margin-bottom: 20px; align-items: flex-start; } .message.user { justify-content: flex-end; } .avatar { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; flex-shrink: 0; margin-top: 5px; background-color: #333; } .message.ai .avatar { margin-right: 12px; } .message.user .avatar { display: none; } .message-body { max-width: 85%; display: flex; flex-direction: column; } .author-header { display: flex; align-items: center; margin-bottom: 5px; flex-wrap: wrap; padding: 0 10px; } .author-header.user { justify-content: flex-end; } .author-name { font-weight: 600; font-size: 0.9em; color: var(--author-name-color); } .message.user .author-name { display: none; } .message-meta { font-size: 0.75em; color: var(--meta-text-color); margin: 0 8px; } .message-content { padding: 12px 18px; border-radius: 20px; line-height: 1.6; word-break: break-word; } .content-text p { margin: 0 0 1em 0; } .content-text p:last-child { margin-bottom: 0; } .message.user .message-body .message-content { background-color: var(--user-bubble-color); } .interactive-message .answer-content { animation: fadeIn 0.3s; } .interactive-message .answer-content .message-content { width: 100%; } @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } } .content-text .chat-image { width: 100%; height: auto; max-height: 400px; object-fit: contain; border-radius: 8px; margin-top: 8px; display: block; margin-left: auto; margin-right: auto; } .alt-controls { margin-top: 10px; padding: 10px 12px; border-radius: 20px; background: #2a2a2a; } .alt-btn { background-color: #444; color: white; border: 1px solid #555; border-radius: 15px; padding: 5px 10px; cursor: pointer; font-size: 12px; margin-right: 5px; transition: all 0.2s; } .interactive-message .alt-btn:hover { background-color: var(--ai-bubble-color); border-color: var(--ai-bubble-color); opacity: 0.8; } .interactive-message .alt-btn.active { background-color: var(--ai-bubble-color); border-color: var(--ai-bubble-color); }
               </style></head><body><div class="container"><div class="header"><h1>${data.characterName}</h1><p class="meta-info">백업 일시: ${utils.formatDate(new Date(data.extractedAt))} / 총 대화 턴 수: ${visibleMessageCount}</p></div>${messagesHtml}</div><script>
                     document.addEventListener('click', function(e) {
                          const target = e.target;
                          if (target.classList.contains('alt-btn')) {
                              const messageBody = target.closest('.message-body');
                              if (!messageBody) return;
                              const interactiveMessage = messageBody.querySelector('.interactive-message');
                              const altIndex = target.getAttribute('data-alt-idx');
                              interactiveMessage.querySelectorAll('.alt-btn').forEach(btn => btn.classList.remove('active'));
                              target.classList.add('active');
                              interactiveMessage.querySelectorAll('.answer-content').forEach(content => content.style.display = 'none');
                              const targetContent = interactiveMessage.querySelector('.answer-content[data-answer-id="' + altIndex + '"]');
                              if (targetContent) {
                                  targetContent.style.display = 'block';
                                  const messageDiv = targetContent.closest('.message.ai');
                                  if(messageDiv) { messageDiv.style.setProperty('--ai-bubble-color', targetContent.style.getPropertyValue('--ai-bubble-color')); }
                                  requestAnimationFrame(() => {
                                      const controls = interactiveMessage.querySelector('.alt-controls');
                                      const controlsRect = controls.getBoundingClientRect();
                                      if (controlsRect.bottom > window.innerHeight) { controls.scrollIntoView({ behavior: 'smooth', block: 'end' }); }
                                  });
                              }
                          }
                     });
                     document.querySelectorAll('.interactive-message').forEach(function(interactiveMessage) {
                          const firstButton = interactiveMessage.querySelector('.alt-btn');
                          if (firstButton) { firstButton.classList.add('active'); }
                     });
               <\/script></body></html>`;
        }
    }

    new BackupUI();
})();