(() => {
    'use strict';

    const TAB_HASH = '#!/subplaces';
    const PAGE_SIZE = 12;

    const placeIdFromUrl = () => {
        const m = location.pathname.match(/\/games\/(\d+)/);
        return m ? m[1] : null;
    };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function getJson(url, init) {
        for (let attempt = 0; attempt < 4; attempt++) {
            const res = await fetch(url, { credentials: 'include', ...init });
            if (res.status === 429) {
                await sleep(1500 * (attempt + 1));
                continue;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
            return res.json();
        }
        throw new Error(`Rate limited: ${url}`);
    }

    async function getUniverseId(placeId) {
        const data = await getJson(
            `https://games.roblox.com/v1/games/multiget-place-details?placeIds=${placeId}`,
        );
        const id = data?.[0]?.universeId;
        if (!id) throw new Error('Universe ID not found');
        return id;
    }

    async function getUniverseInfo(universeId) {
        const data = await getJson(
            `https://games.roblox.com/v1/games?universeIds=${universeId}`,
        );
        return data?.data?.[0] || null;
    }

    async function getSubplaces(universeId) {
        const all = [];
        let cursor = '';
        do {
            const url =
                `https://develop.roblox.com/v2/universes/${universeId}/places?limit=100` +
                (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
            const data = await getJson(url);
            if (Array.isArray(data?.data)) all.push(...data.data);
            cursor = data?.nextPageCursor || '';
        } while (cursor);
        return all;
    }

    async function getThumbnails(placeIds) {
        const map = new Map();
        if (!placeIds.length) return map;
        try {
            const data = await getJson(
                `https://thumbnails.roblox.com/v1/places/gameicons?placeIds=${placeIds.join(',')}` +
                    `&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false`,
            );
            for (const item of data?.data || []) {
                if (item.imageUrl) map.set(item.targetId, item.imageUrl);
            }
        } catch (e) {
            console.warn('Subplaces: thumbnail fetch failed', e);
        }
        return map;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function sortList(list, sort, order) {
        const dir = order === 'asc' ? 1 : -1;
        const out = [...list];
        const time = (v) => new Date(v || 0).getTime();
        if (sort === 'updated') out.sort((a, b) => (time(a.updated) - time(b.updated)) * dir);
        else if (sort === 'created') out.sort((a, b) => (time(a.created) - time(b.created)) * dir);
        else if (sort === 'name') out.sort((a, b) => (a.name || '').localeCompare(b.name || '') * dir);
        else {
            out.sort((a, b) => (b.isRootPlace === true) - (a.isRootPlace === true));
            if (order === 'asc') out.reverse();
        }
        return out;
    }

    function makeSelect(options, initial) {
        const select = el('select');
        for (const [value, label] of options) {
            const opt = el('option', '', label);
            opt.value = value;
            select.appendChild(opt);
        }
        select.value = initial;
        return select;
    }

    function joinLink(placeId, params) {
        const q = new URLSearchParams({ placeId: String(placeId), ...params });
        return `roblox://experiences/start?${q.toString()}`;
    }

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch (e) {
        }
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (!ok) throw new Error('Copy failed');
    }

    async function runCopy(getValue) {
        try {
            const value = typeof getValue === 'function' ? await getValue() : getValue;
            if (!value) throw new Error('Unavailable');
            await copyText(value);
            return 'Copied!';
        } catch (e) {
            const m = String(e.message);
            if (m === 'Cancelled') return null;
            if (m === 'Unavailable') return 'Not available';
            if (m === 'Inactive') return 'Server inactive';
            if (m.includes('HTTP 403') || m.includes('HTTP 401')) return 'Owner only';
            return 'Error';
        }
    }

    let openMenu = null;
    const closeMenu = () => {
        if (!openMenu) return;
        openMenu.classList.remove('sp-open');
        openMenu.firstChild.setAttribute('aria-expanded', 'false');
        openMenu = null;
    };
    document.addEventListener('click', (e) => {
        if (openMenu && !openMenu.contains(e.target)) closeMenu();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeMenu();
    });

    function copyMenu(items) {
        const wrap = el('div', 'sp-menu');
        const toggle = el('button', 'sp-btn sp-menu-toggle', 'Copy \u25BE');
        toggle.type = 'button';
        toggle.setAttribute('aria-haspopup', 'true');
        toggle.setAttribute('aria-expanded', 'false');
        const list = el('div', 'sp-menu-list');
        let busy = false;

        toggle.addEventListener('click', () => {
            if (busy) return;
            const wasOpen = openMenu === wrap;
            closeMenu();
            if (!wasOpen) {
                wrap.classList.add('sp-open');
                toggle.setAttribute('aria-expanded', 'true');
                openMenu = wrap;
            }
        });

        for (const item of items) {
            const b = el('button', 'sp-menu-item', item.label);
            b.type = 'button';
            b.addEventListener('click', async () => {
                if (busy) return;
                busy = true;
                closeMenu();
                toggle.textContent = 'Copying\u2026';
                const msg = await runCopy(item.value);
                toggle.textContent = msg || 'Copy \u25BE';
                setTimeout(() => {
                    toggle.textContent = 'Copy \u25BE';
                    busy = false;
                }, msg ? 1400 : 0);
            });
            list.appendChild(b);
        }

        wrap.append(toggle, list);
        return wrap;
    }

    const vipLinkCache = new Map();
    async function patchJson(url, body) {
        let token = '';
        for (let i = 0; i < 2; i++) {
            const res = await fetch(url, {
                method: 'PATCH',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token },
                body: JSON.stringify(body),
            });
            const next = res.headers.get('x-csrf-token');
            if (res.status === 403 && next && next !== token) {
                token = next;
                continue;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
            return res.json().catch(() => ({}));
        }
        throw new Error(`HTTP 403 for ${url}`);
    }
    async function getPrivateLink(vipServerId) {
        if (vipLinkCache.has(vipServerId)) return vipLinkCache.get(vipServerId);
        const url = `https://games.roblox.com/v1/vip-servers/${vipServerId}`;
        let data = await getJson(url);
        if (data?.link) {
            vipLinkCache.set(vipServerId, data.link);
            return data.link;
        }
        if (data?.active === false) throw new Error('Inactive');
        if (!window.confirm('This private server has no join link yet.\n\nGenerate one now? (Only the owner can do this.)')) {
            throw new Error('Cancelled');
        }
        await patchJson(url, { newJoinCode: true });
        data = await getJson(url);
        if (!data?.link) throw new Error('Unavailable');
        vipLinkCache.set(vipServerId, data.link);
        return data.link;
    }

    function codeFromLink(link) {
        try {
            return new URL(link).searchParams.get('privateServerLinkCode');
        } catch (e) {
            return null;
        }
    }

    async function getHeadshots(userIds) {
        const map = new Map();
        const ids = [...new Set(userIds)];
        if (!ids.length) return map;
        try {
            const data = await getJson(
                `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${ids.join(',')}` +
                    `&size=48x48&format=Png&isCircular=true`,
            );
            for (const item of data?.data || []) {
                if (item.imageUrl) map.set(item.targetId, item.imageUrl);
            }
        } catch (e) {
            console.warn('Subplaces: avatar fetch failed', e);
        }
        return map;
    }

    function ownerBadge(owner, avatarUrl) {
        const a = el('a', 'sp-owner');
        a.href = `https://www.roblox.com/users/${owner.id}/profile`;
        const img = el('img', 'sp-owner-img');
        img.alt = '';
        if (avatarUrl) img.src = avatarUrl;
        a.append(img, el('span', 'sp-owner-name', owner.displayName || owner.name || `User ${owner.id}`));
        return a;
    }

    function serverRow(opts) {
        const row = el('div', 'sp-row');
        const info = el('div', 'sp-row-info');
        info.appendChild(el('div', 'sp-row-main', opts.main));
        if (opts.sub) info.appendChild(el('div', 'sp-row-sub', opts.sub));
        if (opts.owner) info.appendChild(opts.owner);
        row.appendChild(info);

        const actions = el('div', 'sp-row-actions');
        for (const b of opts.buttons || []) actions.appendChild(b);
        if (opts.joinHref) {
            const a = el('a', 'sp-btn sp-join', 'Join');
            a.href = opts.joinHref;
            actions.appendChild(a);
        } else if (opts.status) {
            actions.appendChild(el('span', 'sp-row-sub', opts.status));
        }
        row.appendChild(actions);
        return row;
    }

    function createServerPanel(placeId, kind) {
        const isPublic = kind === 'public';
        const panel = el('div', 'sp-panel');
        panel.hidden = true;

        const head = el('div', 'sp-panel-head');
        head.appendChild(el('strong', '', isPublic ? 'Public servers' : 'Private servers'));
        const sortSel = isPublic
            ? makeSelect([['Desc', 'Most players'], ['Asc', 'Fewest players']], 'Desc')
            : null;
        if (sortSel) head.appendChild(sortSel);
        const refresh = el('button', 'sp-btn', 'Refresh');
        head.appendChild(refresh);

        const rows = el('div', 'sp-rows');
        const more = el('button', 'sp-btn sp-panel-more', 'Load more');
        more.hidden = true;
        panel.append(head, rows, more);

        if (!isPublic) {
            const foot = el('div', 'sp-panel-foot');
            const create = el('a', 'sp-btn', 'Create / manage private servers');
            create.href = `https://www.roblox.com/games/${placeId}/#!/private-servers`;
            foot.appendChild(create);
            panel.appendChild(foot);
        }

        let cursor = '';
        let busy = false;
        let loadedOnce = false;

        async function load(reset) {
            if (busy) return;
            busy = true;
            if (reset) {
                cursor = '';
                rows.textContent = '';
                rows.appendChild(el('p', 'sp-message', 'Loading...'));
            }
            more.hidden = true;
            try {
                const base = isPublic
                    ? `https://games.roblox.com/v1/games/${placeId}/servers/Public?limit=25&excludeFullGames=false&sortOrder=${sortSel.value}`
                    : `https://games.roblox.com/v1/games/${placeId}/private-servers?limit=25&sortOrder=Asc`;
                const data = await getJson(base + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
                if (reset) rows.textContent = '';
                const items = Array.isArray(data?.data) ? data.data : [];
                if (!items.length && reset) {
                    rows.appendChild(
                        el('p', 'sp-message', isPublic ? 'No public servers are running.' : 'You have no private servers here.'),
                    );
                }
                const avatars = isPublic
                    ? new Map()
                    : await getHeadshots(items.map((s) => s.owner?.id).filter(Boolean));
                for (const s of items) {
                    const players = `${s.playing ?? 0}/${s.maxPlayers ?? '?'} players`;
                    const ping = typeof s.ping === 'number' ? ` · ${Math.round(s.ping)} ms` : '';
                    if (isPublic) {
                        const full = s.maxPlayers && s.playing >= s.maxPlayers;
                        rows.appendChild(
                            serverRow({
                                main: players + ping,
                                sub: `ID ${String(s.id).slice(0, 8)}…`,
                                buttons: [
                                    copyMenu([
                                        { label: 'Instance ID', value: String(s.id) },
                                        { label: 'Launch Instance', value: joinLink(placeId, { gameInstanceId: s.id }) },
                                    ]),
                                ],
                                joinHref: full ? null : joinLink(placeId, { gameInstanceId: s.id }),
                                status: full ? 'Full' : '',
                            }),
                        );
                    } else {
                        const menuItems = [];
                        if (s.accessCode) {
                            menuItems.push(
                                { label: 'Access code', value: String(s.accessCode) },
                                { label: 'Launch link', value: joinLink(placeId, { accessCode: s.accessCode }) },
                            );
                        }
                        if (s.vipServerId) {
                            menuItems.push(
                                { label: 'Private Server code', value: async () => codeFromLink(await getPrivateLink(s.vipServerId)) },
                                { label: 'Privatr Server link share code', value: () => getPrivateLink(s.vipServerId) },
                            );
                        }
                        if (s.id) menuItems.push({ label: 'Instance ID', value: String(s.id) });
                        const buttons = menuItems.length ? [copyMenu(menuItems)] : [];
                        rows.appendChild(
                            serverRow({
                                main: s.name || 'Private server',
                                sub: players,
                                owner: s.owner?.id ? ownerBadge(s.owner, avatars.get(s.owner.id)) : null,
                                buttons,
                                joinHref: s.accessCode ? joinLink(placeId, { accessCode: s.accessCode }) : null,
                            }),
                        );
                    }
                }
                cursor = data?.nextPageCursor || '';
                more.hidden = !cursor;
                loadedOnce = true;
            } catch (e) {
                console.warn('Subplaces: server fetch failed', e);
                if (reset) rows.textContent = '';
                rows.appendChild(el('p', 'sp-message', 'Could not load servers. Are you logged in?'));
            } finally {
                busy = false;
            }
        }

        refresh.addEventListener('click', () => load(true));
        more.addEventListener('click', () => load(false));
        if (sortSel) sortSel.addEventListener('change', () => load(true));

        return {
            panel,
            toggle() {
                panel.hidden = !panel.hidden;
                if (!panel.hidden && !loadedOnce) load(true);
                return !panel.hidden;
            },
        };
    }

    const STATS_PAGES = 2;
    const STATS_TTL = 60 * 1000;
    const statsCache = new Map();
    const statsQueue = [];
    let statsActive = 0;

    function pumpStats() {
        while (statsActive < 2 && statsQueue.length) {
            const job = statsQueue.shift();
            statsActive++;
            job.task()
                .then(job.resolve, job.reject)
                .finally(() => {
                    statsActive--;
                    pumpStats();
                });
        }
    }

    function getPlaceStats(placeId) {
        const hit = statsCache.get(placeId);
        if (hit && Date.now() - hit.time < STATS_TTL) return hit.promise;
        const promise = new Promise((resolve, reject) => {
            statsQueue.push({
                resolve,
                reject,
                task: async () => {
                    let playing = 0;
                    let max = null;
                    let servers = 0;
                    let cursor = '';
                    let pages = 0;
                    do {
                        const data = await getJson(
                            `https://games.roblox.com/v1/games/${placeId}/servers/Public?limit=100&excludeFullGames=false` +
                                (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
                        );
                        for (const s of data?.data || []) {
                            servers++;
                            playing += s.playing ?? 0;
                            if (typeof s.maxPlayers === 'number') max = Math.max(max ?? 0, s.maxPlayers);
                        }
                        cursor = data?.nextPageCursor || '';
                        pages++;
                    } while (cursor && pages < STATS_PAGES);
                    return { playing, max, servers, partial: Boolean(cursor) };
                },
            });
            pumpStats();
        });
        statsCache.set(placeId, { time: Date.now(), promise });
        promise.catch(() => statsCache.delete(placeId));
        return promise;
    }

    function statsLine(placeId) {
        const node = el('div', 'sp-stats', 'Loading players\u2026');
        getPlaceStats(placeId)
            .then((st) => {
                const playing = `${st.playing}${st.partial ? '+' : ''} playing`;
                node.textContent = `${playing} \u00B7 max ${st.max ?? '\u2014'}`;
                node.title = st.servers
                    ? 'Active players in public servers \u00B7 max players per server'
                    : 'No public servers are running, so max players is unknown';
            })
            .catch(() => {
                node.textContent = 'Players unavailable';
            });
        return node;
    }

    function buildTab(universeId, tabsContainer, contentSection) {
        const tab = el('li', 'rbx-tab tab-subplaces');
        tab.id = 'tab-subplaces';
        const link = el('a', 'rbx-tab-heading');
        link.appendChild(el('span', 'text-lead', 'Subplaces'));
        tab.appendChild(link);

        const pane = el('div', 'tab-pane');
        pane.id = 'subplaces-content-pane';

        tabsContainer.appendChild(tab);
        contentSection.appendChild(pane);
        tabsContainer.style.display = 'flex';
        tabsContainer.style.flexWrap = 'nowrap';
        tabsContainer.querySelectorAll('.rbx-tab').forEach((t) => {
            t.style.width = 'auto';
            t.style.flex = '1 1 auto';
            t.style.float = 'none';
            t.style.minWidth = '0';
        });

        const controls = el('div', 'sp-controls');
        const search = el('input');
        search.type = 'search';
        search.placeholder = 'Search subplaces';
        const sortSel = makeSelect(
            [['default', 'Default'], ['updated', 'Updated'], ['created', 'Created'], ['name', 'Name']],
            'default',
        );
        const orderSel = makeSelect([['desc', 'Descending'], ['asc', 'Ascending']], 'desc');
        controls.append(search, sortSel, orderSel);

        const list = el('div', 'sp-list');
        const more = el('button', 'sp-more', 'Load more');
        pane.append(controls, list, more);

        let raw = [];
        let sorted = [];
        let shown = 0;
        let loaded = false;

        const matches = (p) =>
            (p.name || '').toLowerCase().includes(search.value.trim().toLowerCase());

        async function renderMore() {
            const filtered = sorted.filter(matches);
            const batch = filtered.slice(shown, shown + PAGE_SIZE);
            if (batch.length) {
                const thumbs = await getThumbnails(batch.map((p) => p.id));
                for (const p of batch) {
                    const card = el('a', 'sp-card');
                    card.href = `https://www.roblox.com/games/${p.id}/`;
                    const img = el('img', 'sp-thumb');
                    img.alt = '';
                    img.loading = 'lazy';
                    const src = thumbs.get(p.id);
                    if (src) img.src = src;
                    card.append(img, el('div', 'sp-name', p.name || `Place ${p.id}`));
                    if (p.isRootPlace) card.appendChild(el('div', 'sp-label', 'Main place'));

                    const item = el('div', 'sp-item');
                    const actions = el('div', 'sp-actions');

                    // Launch this specific subplace in the Roblox client.
                    const joinBtn = el('a', 'sp-btn sp-join', 'Join');
                    joinBtn.href = joinLink(p.id, {});
                    joinBtn.title = 'Launch this subplace in the Roblox app';

                    // Copy menu with the place id and deep link.
                    const copyBtn = copyMenu([
                        { label: 'Place ID', value: String(p.id) },
                        { label: 'Launch link', value: joinLink(p.id, {}) },
                    ]);

                    const serversBtn = el('button', 'sp-btn sp-servers-btn', 'Servers');
                    const privateBtn = el('button', 'sp-btn sp-private-btn', 'Private');
                    actions.append(joinBtn, copyBtn, serversBtn, privateBtn);
                    item.append(card, statsLine(p.id), actions);

                    const pub = createServerPanel(p.id, 'public');
                    const priv = createServerPanel(p.id, 'private');
                    serversBtn.addEventListener('click', () => {
                        serversBtn.classList.toggle('sp-on', pub.toggle());
                    });
                    privateBtn.addEventListener('click', () => {
                        privateBtn.classList.toggle('sp-on', priv.toggle());
                    });
                    list.append(item, pub.panel, priv.panel);
                }
                shown += batch.length;
            }
            more.style.display = shown < filtered.length ? 'block' : 'none';
        }

        async function rerender() {
            sorted = sortList(raw, sortSel.value, orderSel.value);
            shown = 0;
            list.textContent = '';
            if (!sorted.filter(matches).length) {
                list.appendChild(el('p', 'sp-message', raw.length ? 'No matches.' : 'This experience has no subplaces.'));
                more.style.display = 'none';
                return;
            }
            await renderMore();
        }

        async function loadData() {
            if (loaded) return;
            loaded = true;
            list.appendChild(el('p', 'sp-message', 'Loading...'));
            try {
                raw = await getSubplaces(universeId);
                await rerender();
            } catch (e) {
                console.warn('Subplaces: load failed', e);
                list.textContent = '';
                list.appendChild(el('p', 'sp-message', 'Failed to load subplaces.'));
                loaded = false;
            }
        }

        let timer;
        search.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(rerender, 200);
        });
        sortSel.addEventListener('change', rerender);
        orderSel.addEventListener('change', rerender);
        more.addEventListener('click', renderMore);

        function activate() {
            document
                .querySelectorAll('.rbx-tab.active, .tab-pane.active')
                .forEach((n) => n.classList.remove('active'));
            tab.classList.add('active');
            pane.classList.add('active');
            loadData();
        }

        tab.addEventListener('click', (e) => {
            e.preventDefault();
            activate();
            if (location.hash !== TAB_HASH) location.hash = TAB_HASH;
        });

        document.addEventListener(
            'click',
            (e) => {
                const t = e.target.closest && e.target.closest('.rbx-tab');
                if (t && t !== tab) {
                    tab.classList.remove('active');
                    pane.classList.remove('active');
                }
            },
            true,
        );

        if (location.hash === TAB_HASH) setTimeout(activate, 200);
        window.addEventListener('hashchange', () => {
            if (location.hash === TAB_HASH) activate();
        });
    }

    function showBanner(rootPlaceId, rootName, subplaceId) {
        const parent = document.querySelector('#game-detail-page');
        if (!parent || document.getElementById('sp-banner')) return;
        const banner = el('div', 'sp-banner');
        banner.id = 'sp-banner';
        banner.append('This is a subplace of ');
        const a = el('a', '', rootName || 'the main experience');
        a.href = `https://www.roblox.com/games/${rootPlaceId}/`;
        banner.append(a, '. ');

        if (subplaceId) {
            const join = el('a', 'sp-btn sp-join', 'Play this subplace');
            join.href = joinLink(subplaceId, {});
            join.title = 'Launch this subplace in the Roblox app';
            banner.appendChild(join);
        }

        parent.prepend(banner);
    }

    let failures = 0;

    async function init(tabsContainer) {
        if (tabsContainer.dataset.spInit === '1' || failures >= 3) return;
        tabsContainer.dataset.spInit = '1';

        const placeId = placeIdFromUrl();
        const contentSection = document.querySelector('.tab-content.rbx-tab-content');
        if (!placeId || !contentSection) {
            tabsContainer.dataset.spInit = '0';
            return;
        }

        try {
            const universeId = await getUniverseId(placeId);
            buildTab(universeId, tabsContainer, contentSection);
            const info = await getUniverseInfo(universeId).catch(() => null);
            if (info?.rootPlaceId && String(info.rootPlaceId) !== placeId) {
                showBanner(info.rootPlaceId, info.name, placeId);
            }
        } catch (e) {
            console.warn('Subplaces: init failed', e);
            failures++;
            tabsContainer.dataset.spInit = '0';
        }
    }

    function check() {
        if (!placeIdFromUrl()) return;
        const tabs = document.querySelector('#horizontal-tabs');
        if (tabs && !document.getElementById('tab-subplaces')) init(tabs);
    }

    if (placeIdFromUrl()) {
        check();
        new MutationObserver(check).observe(document.documentElement, {
            childList: true,
            subtree: true,
        });
    }
})();