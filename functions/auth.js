// JWT utilities (Web Crypto API only, no external dependencies)

function b64url(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(str) {
    return atob(str.replace(/-/g, '+').replace(/_/g, '/'));
}

async function getHmacKey(secret) {
    return crypto.subtle.importKey(
        'raw', new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
    );
}

async function signJWT(payload, secret) {
    const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const body   = b64url(new TextEncoder().encode(JSON.stringify(payload)));
    const key    = await getHmacKey(secret);
    const sig    = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`));
    return `${header}.${body}.${b64url(sig)}`;
}

async function verifyJWT(token, secret) {
    const parts = (token || '').split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    try {
        const key   = await getHmacKey(secret);
        const valid = await crypto.subtle.verify(
            'HMAC', key,
            Uint8Array.from(b64urlDecode(sig), c => c.charCodeAt(0)),
            new TextEncoder().encode(`${header}.${body}`)
        );
        if (!valid) return null;
        const payload = JSON.parse(b64urlDecode(body));
        if (payload.exp && Date.now() / 1000 > payload.exp) return null;
        return payload;
    } catch {
        return null;
    }
}

function getCookie(request, name) {
    const cookies = request.headers.get('Cookie') || '';
    const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
}

function authCookieHeader(token) {
    const maxAge = 60 * 60 * 24 * 30; // 30 days
    return `auth_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function clearCookieHeader() {
    return 'auth_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
}

// Password hashing with PBKDF2-SHA256
async function hashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key  = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256
    );
    return `pbkdf2:${b64url(salt)}:${b64url(bits)}`;
}

async function verifyPassword(password, stored) {
    const parts = stored.split(':');
    if (parts.length !== 3 || parts[0] !== 'pbkdf2') return false;
    const salt = Uint8Array.from(b64urlDecode(parts[1]), c => c.charCodeAt(0));
    const key  = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256
    );
    return parts[2] === b64url(bits);
}

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...extraHeaders }
    });
}

export async function onRequestPost({ request, env }) {
    const secret = env.JWT_SECRET;
    if (!secret) return json({ ok: false, error: 'JWT_SECRET not configured' }, 500);

    let data;
    try { data = await request.json(); } catch { data = {}; }
    const action = data.action || '';

    if (action === 'check') {
        const token   = getCookie(request, 'auth_token');
        const payload = await verifyJWT(token, secret);
        if (payload) return json({ ok: true, username: payload.username });
        return json({ ok: false });
    }

    if (action === 'logout') {
        return json({ ok: true }, 200, { 'Set-Cookie': clearCookieHeader() });
    }

    if (action === 'register') {
        const username = (data.username || '').trim();
        const password = data.password || '';

        if (!/^[a-zA-Z0-9]{1,32}$/.test(username))
            return json({ ok: false, error: 'IDは半角英数字1〜32文字で入力してください' }, 400);
        if (password.length < 8)
            return json({ ok: false, error: 'パスワードは8文字以上で入力してください' }, 400);

        const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
        if (existing) return json({ ok: false, error: 'そのIDは既に使われています' }, 409);

        const hash = await hashPassword(password);
        const result = await env.DB.prepare('INSERT INTO users (username, password) VALUES (?, ?)')
            .bind(username, hash).run();
        const userId = result.meta.last_row_id;

        const token = await signJWT(
            { sub: userId, username, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 },
            secret
        );
        return json({ ok: true, username }, 200, { 'Set-Cookie': authCookieHeader(token) });
    }

    if (action === 'login') {
        const username = (data.username || '').trim();
        const password = data.password || '';

        if (!/^[a-zA-Z0-9]{1,32}$/.test(username) || !password)
            return json({ ok: false, error: '入力が正しくありません' }, 400);

        const user = await env.DB.prepare('SELECT id, password FROM users WHERE username = ?').bind(username).first();
        if (!user || !(await verifyPassword(password, user.password)))
            return json({ ok: false, error: 'IDまたはパスワードが違います' }, 401);

        const token = await signJWT(
            { sub: user.id, username, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 },
            secret
        );
        return json({ ok: true, username }, 200, { 'Set-Cookie': authCookieHeader(token) });
    }

    return json({ ok: false, error: '不正なアクション' }, 400);
}
