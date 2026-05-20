// ---- JWT / Auth helpers (shared with auth.js) ----

function b64urlDecode(str) {
    return atob(str.replace(/-/g, '+').replace(/_/g, '/'));
}

async function verifyJWT(token, secret) {
    const parts = (token || '').split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    try {
        const key = await crypto.subtle.importKey(
            'raw', new TextEncoder().encode(secret),
            { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
        );
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

async function requireAuth(request, env) {
    const token = getCookie(request, 'auth_token');
    return await verifyJWT(token, env.JWT_SECRET);
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

// ---- Task row → JS object ----

function taskRowToJs(row) {
    return {
        id:            row.id,
        date:          row.date,
        title:         row.title,
        memo:          row.memo,
        url:           row.url,
        done:          !!row.done,
        color:         row.color,
        estimate:      row.estimate,
        actual:        row.actual,
        order:         row.task_order,
        startTime:     row.start_time,
        repeatDays:    JSON.parse(row.repeat_days || '[]'),
        templateId:    row.template_id ?? null,
        scheduledTime: row.scheduled_time || '',
        waiting:       !!row.waiting,
        waitUntil:     row.wait_until || '',
    };
}

function templateRowToJs(row) {
    return {
        id:             row.id,
        title:          row.title,
        memo:           row.memo,
        url:            row.url,
        color:          row.color,
        estimate:       row.estimate,
        fixedStartTime: row.fixed_start_time,
        rule:           JSON.parse(row.rule || '{}'),
        skippedDates:   JSON.parse(row.skipped_dates || '[]'),
        generatedCount: row.generated_count,
    };
}

// ---- Recurrence helpers ----

function isNthWeekdayOfMonth(d, nth, weekday) {
    if (d.getDay() !== weekday) return false;
    return Math.ceil(d.getDate() / 7) === nth;
}

function isLastWeekdayOfMonth(d, weekday) {
    if (d.getDay() !== weekday) return false;
    const next = new Date(d);
    next.setDate(d.getDate() + 7);
    return next.getMonth() !== d.getMonth();
}

function occursOnDate(rule, dateStr) {
    const freq     = rule.frequency || 'daily';
    const interval = Math.max(1, rule.interval || 1);
    const startStr = rule.startDate || '';
    if (!startStr) return false;

    const start = new Date(startStr);
    const check = new Date(dateStr);
    if (check < start) return false;

    if (rule.endType === 'until_date' && rule.endDate && check > new Date(rule.endDate)) return false;

    const diffDays = Math.round((check - start) / 86400000);

    if (freq === 'daily') return diffDays % interval === 0;

    if (freq === 'weekly') {
        const days = rule.daysOfWeek || [];
        if (!days.includes(check.getDay())) return false;
        const startSun = new Date(start); startSun.setDate(start.getDate() - start.getDay());
        const checkSun = new Date(check); checkSun.setDate(check.getDate() - check.getDay());
        const weekDiff = Math.round((checkSun - startSun) / 604800000);
        return weekDiff % interval === 0;
    }

    if (freq === 'monthly') {
        const monthDiff = (check.getFullYear() - start.getFullYear()) * 12 + (check.getMonth() - start.getMonth());
        if (monthDiff < 0 || monthDiff % interval !== 0) return false;
        const mType = rule.monthlyType || 'day_of_month';
        if (mType === 'day_of_month') return check.getDate() === (rule.monthlyDay || 1);
        if (mType === 'nth_weekday')  return isNthWeekdayOfMonth(check, rule.monthlyNth || 1, rule.monthlyWeekday || 0);
        if (mType === 'last_weekday') return isLastWeekdayOfMonth(check, rule.monthlyWeekday || 0);
        return false;
    }

    if (freq === 'yearly') {
        const yearDiff = check.getFullYear() - start.getFullYear();
        if (yearDiff < 0 || yearDiff % interval !== 0) return false;
        if (check.getMonth() !== (rule.yearlyMonth || 1) - 1) return false;
        if (rule.yearlyNth) return isNthWeekdayOfMonth(check, rule.yearlyNth, rule.yearlyWeekday || 0);
        return check.getDate() === (rule.yearlyDay || 1);
    }

    if (freq === 'custom') {
        const unit = rule.unit || 'day';
        if (unit === 'day') return diffDays % interval === 0;
        if (unit === 'week') {
            const days = rule.daysOfWeek || [];
            if (!days.includes(check.getDay())) return false;
            const startSun = new Date(start); startSun.setDate(start.getDate() - start.getDay());
            const checkSun = new Date(check); checkSun.setDate(check.getDate() - check.getDay());
            return Math.round((checkSun - startSun) / 604800000) % interval === 0;
        }
        if (unit === 'month') {
            const monthDiff = (check.getFullYear() - start.getFullYear()) * 12 + (check.getMonth() - start.getMonth());
            return monthDiff >= 0 && monthDiff % interval === 0 && check.getDate() === start.getDate();
        }
        if (unit === 'year') {
            const yearDiff = check.getFullYear() - start.getFullYear();
            return yearDiff >= 0 && yearDiff % interval === 0 &&
                check.getMonth() === start.getMonth() && check.getDate() === start.getDate();
        }
    }

    return false;
}

async function generateTemplateInstances(db, userId, today) {
    const windowEnd = new Date(today);
    windowEnd.setDate(windowEnd.getDate() + 90);
    const windowEndStr = windowEnd.toISOString().slice(0, 10);

    const templates = (await db.prepare('SELECT * FROM repeat_templates WHERE user_id = ?').bind(userId).all()).results;
    if (!templates.length) return;

    const existingRows = (await db.prepare(
        'SELECT template_id, date FROM tasks WHERE user_id=? AND template_id IS NOT NULL AND date>=? AND date<=?'
    ).bind(userId, today, windowEndStr).all()).results;

    const existing = new Set(existingRows.map(r => `${r.template_id}|${r.date}`));

    for (const tpl of templates) {
        const rule     = JSON.parse(tpl.rule || '{}');
        const skipped  = JSON.parse(tpl.skipped_dates || '[]');
        let   genCount = tpl.generated_count;
        const endType  = rule.endType || 'never';
        const endCount = rule.endCount || 0;
        const tplId    = tpl.id;
        const ruleStart = rule.startDate || today;
        const winStart  = ruleStart > today ? ruleStart : today;

        let cursor = new Date(winStart);
        const end  = new Date(windowEndStr);
        let newlyGenerated = 0;
        const inserts = [];

        while (cursor <= end) {
            const dateStr = cursor.toISOString().slice(0, 10);
            if (endType === 'count' && (genCount + newlyGenerated) >= endCount) break;
            if (skipped.includes(dateStr)) { cursor.setDate(cursor.getDate() + 1); continue; }

            const key = `${tplId}|${dateStr}`;
            if (existing.has(key)) { cursor.setDate(cursor.getDate() + 1); continue; }
            if (!occursOnDate(rule, dateStr)) { cursor.setDate(cursor.getDate() + 1); continue; }

            const orderRow = await db.prepare(
                'SELECT COALESCE(MAX(task_order), -1) + 1 AS next_order FROM tasks WHERE user_id=? AND date=?'
            ).bind(userId, dateStr).first();
            const newOrder = orderRow?.next_order ?? 0;
            const newId    = `tpl${tplId}_${dateStr.replace(/-/g, '')}`;

            inserts.push(db.prepare(
                `INSERT INTO tasks (id, user_id, date, title, memo, url, done, color, estimate, actual,
                 task_order, start_time, repeat_days, template_id, scheduled_time)
                 VALUES (?,?,?,?,?,?,0,?,?,0,?,0,'[]',?,?)`
            ).bind(newId, userId, dateStr, tpl.title, tpl.memo, tpl.url,
                   tpl.color, tpl.estimate, newOrder, tplId, tpl.fixed_start_time));

            existing.add(key);
            newlyGenerated++;
            cursor.setDate(cursor.getDate() + 1);
        }

        if (inserts.length) await db.batch(inserts);

        if (newlyGenerated > 0 && endType === 'count') {
            await db.prepare('UPDATE repeat_templates SET generated_count=generated_count+? WHERE id=?')
                .bind(newlyGenerated, tplId).run();
        }
    }
}

// ---- FIELD_MAP ----

const FIELD_MAP = {
    date:          'date',
    title:         'title',
    memo:          'memo',
    url:           'url',
    done:          'done',
    color:         'color',
    estimate:      'estimate',
    actual:        'actual',
    order:         'task_order',
    startTime:     'start_time',
    repeatDays:    'repeat_days',
    scheduledTime: 'scheduled_time',
    waiting:       'waiting',
    waitUntil:     'wait_until',
};

function toDbValue(jsKey, value) {
    if (jsKey === 'done' || jsKey === 'waiting') return value ? 1 : 0;
    if (jsKey === 'repeatDays') return JSON.stringify(value);
    if (['estimate', 'actual', 'order', 'startTime'].includes(jsKey)) return parseInt(value) || 0;
    return value;
}

// ---- Main handler ----

export async function onRequestPost({ request, env }) {
    const user = await requireAuth(request, env);
    if (!user) return json({ ok: false, error: 'Unauthorized' }, 401);
    const userId = user.sub;
    const db = env.DB;

    let data;
    try { data = await request.json(); } catch { data = {}; }
    const action = data.action || '';

    // Tokyo time helper
    const tokyoDate = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

    if (action === 'load') {
        const today = tokyoDate();
        await generateTemplateInstances(db, userId, today);
        const rows = (await db.prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY date, task_order').bind(userId).all()).results;
        return json(rows.map(taskRowToJs));
    }

    if (action === 'list_templates') {
        const rows = (await db.prepare('SELECT * FROM repeat_templates WHERE user_id = ? ORDER BY id ASC').bind(userId).all()).results;
        return json(rows.map(templateRowToJs));
    }

    if (action === 'save_template') {
        const t = data.template || {};
        const title          = (t.title || '').trim();
        const estimate       = Math.max(1, parseInt(t.estimate) || 15);
        const color          = t.color || '#B2DFDB';
        const memo           = t.memo || '';
        const url            = t.url || '';
        const fixedStartTime = t.fixedStartTime || '';
        const rule           = t.rule || {};
        const ruleJson       = JSON.stringify(rule);

        if (!rule.frequency || !rule.startDate)
            return json({ ok: false, error: 'frequencyとstartDateは必須です' }, 400);

        const templateId = t.id ? parseInt(t.id) : null;

        if (templateId) {
            const existing = await db.prepare('SELECT id, rule FROM repeat_templates WHERE id=? AND user_id=?').bind(templateId, userId).first();
            if (!existing) return json({ ok: false, error: 'テンプレートが見つかりません' }, 404);
            const ruleChanged = existing.rule !== ruleJson;
            if (ruleChanged) {
                await db.prepare(
                    `UPDATE repeat_templates SET title=?,memo=?,url=?,color=?,estimate=?,fixed_start_time=?,
                     rule=?,skipped_dates='[]',generated_count=0 WHERE id=? AND user_id=?`
                ).bind(title, memo, url, color, estimate, fixedStartTime, ruleJson, templateId, userId).run();
            } else {
                await db.prepare(
                    'UPDATE repeat_templates SET title=?,memo=?,url=?,color=?,estimate=?,fixed_start_time=?,rule=? WHERE id=? AND user_id=?'
                ).bind(title, memo, url, color, estimate, fixedStartTime, ruleJson, templateId, userId).run();
            }
        } else {
            const result = await db.prepare(
                'INSERT INTO repeat_templates (user_id,title,memo,url,color,estimate,fixed_start_time,rule) VALUES (?,?,?,?,?,?,?,?)'
            ).bind(userId, title, memo, url, color, estimate, fixedStartTime, ruleJson).run();
            const row = await db.prepare('SELECT * FROM repeat_templates WHERE id=?').bind(result.meta.last_row_id).first();
            return json({ ok: true, template: templateRowToJs(row) });
        }

        const row = await db.prepare('SELECT * FROM repeat_templates WHERE id=? AND user_id=?').bind(templateId, userId).first();
        return json({ ok: true, template: templateRowToJs(row) });
    }

    if (action === 'delete_template') {
        const templateId = parseInt(data.id) || 0;
        if (!templateId) return json({ ok: false, error: 'IDが必要です' }, 400);
        const existing = await db.prepare('SELECT id FROM repeat_templates WHERE id=? AND user_id=?').bind(templateId, userId).first();
        if (!existing) return json({ ok: false, error: 'テンプレートが見つかりません' }, 404);
        const today = tokyoDate();
        await db.batch([
            db.prepare('DELETE FROM tasks WHERE template_id=? AND user_id=? AND date>?').bind(templateId, userId, today),
            db.prepare('DELETE FROM repeat_templates WHERE id=? AND user_id=?').bind(templateId, userId),
        ]);
        return json({ ok: true });
    }

    if (action === 'add') {
        const t  = data.task || {};
        const id = (t.id || '').replace(/[^a-zA-Z0-9]/g, '');
        if (!id) return json({ ok: false, error: 'IDが不正です' }, 400);
        await db.prepare(
            `INSERT OR REPLACE INTO tasks
             (id, user_id, date, title, memo, url, done, color, estimate, actual,
              task_order, start_time, repeat_days, scheduled_time, waiting, wait_until)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
            id, userId,
            t.date          || '',
            t.title         || '',
            t.memo          || '',
            t.url           || '',
            t.done          ? 1 : 0,
            t.color         || '#B2DFDB',
            parseInt(t.estimate) || 15,
            parseInt(t.actual)   || 0,
            parseInt(t.order)    || 0,
            parseInt(t.startTime)|| 0,
            JSON.stringify(t.repeatDays || []),
            t.scheduledTime || '',
            t.waiting       ? 1 : 0,
            t.waitUntil     || '',
        ).run();
        const row = await db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').bind(id, userId).first();
        return json({ ok: true, task: taskRowToJs(row) });
    }

    if (action === 'update') {
        const id     = data.id || '';
        const fields = data.fields || {};
        if (!id || !Object.keys(fields).length) return json({ ok: false, error: '入力が不正です' }, 400);

        const sets   = [];
        const params = [];
        for (const [jsKey, value] of Object.entries(fields)) {
            if (!FIELD_MAP[jsKey]) continue;
            sets.push(`${FIELD_MAP[jsKey]} = ?`);
            params.push(toDbValue(jsKey, value));
        }
        if (!sets.length) return json({ ok: false, error: '更新フィールドがありません' }, 400);

        await db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id=? AND user_id=?`)
            .bind(...params, id, userId).run();
        return json({ ok: true });
    }

    if (action === 'delete') {
        const id = data.id || '';
        if (!id) return json({ ok: false, error: 'IDが必要です' }, 400);
        const task = await db.prepare('SELECT template_id, date FROM tasks WHERE id=? AND user_id=?').bind(id, userId).first();
        if (task?.template_id) {
            const tpl = await db.prepare('SELECT skipped_dates FROM repeat_templates WHERE id=? AND user_id=?').bind(task.template_id, userId).first();
            if (tpl) {
                const skipped = JSON.parse(tpl.skipped_dates || '[]');
                if (!skipped.includes(task.date)) {
                    skipped.push(task.date);
                    await db.prepare('UPDATE repeat_templates SET skipped_dates=? WHERE id=? AND user_id=?')
                        .bind(JSON.stringify(skipped), task.template_id, userId).run();
                }
            }
        }
        await db.prepare('DELETE FROM tasks WHERE id=? AND user_id=?').bind(id, userId).run();
        return json({ ok: true });
    }

    if (action === 'reorder') {
        const date  = data.date  || '';
        const order = data.order || [];
        if (!date || !Array.isArray(order)) return json({ ok: false, error: '入力が不正です' }, 400);
        const stmts = order.map((id, i) =>
            db.prepare('UPDATE tasks SET task_order=? WHERE id=? AND user_id=?').bind(i, id, userId)
        );
        if (stmts.length) await db.batch(stmts);
        return json({ ok: true });
    }

    if (action === 'interrupt') {
        const id    = data.id    || '';
        const nowMs = parseInt(data.now_ms) || 0;
        if (!id || !nowMs) return json({ ok: false, error: '入力が不正です' }, 400);

        const task = await db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').bind(id, userId).first();
        if (!task || !task.start_time || task.done) return json({ ok: false, error: '対象タスクが不正です' }, 400);

        const rawMin  = (nowMs - task.start_time) / 60000;
        const actual  = rawMin < 1 ? 1 : Math.floor(rawMin);
        const remaining  = Math.max(1, task.estimate - actual);
        const cloneTitle = task.title + '（中断）';
        const newEstimate = Math.min(task.estimate, actual);

        const nextRow = await db.prepare(
            'SELECT task_order FROM tasks WHERE user_id=? AND date=? AND done=0 AND start_time=0 AND task_order>? ORDER BY task_order ASC LIMIT 1'
        ).bind(userId, task.date, task.task_order).first();
        const cloneOrder = nextRow ? nextRow.task_order - 0.5 : task.task_order + 1;
        const cloneId    = String(nowMs);

        await db.batch([
            db.prepare('UPDATE tasks SET done=1, actual=?, estimate=?, title=? WHERE id=? AND user_id=?')
                .bind(actual, newEstimate, cloneTitle, id, userId),
            db.prepare(
                `INSERT INTO tasks (id, user_id, date, title, memo, url, done, color, estimate, actual,
                 task_order, start_time, repeat_days)
                 VALUES (?,?,?,?,?,?,0,?,?,0,?,0,?)`
            ).bind(cloneId, userId, task.date, task.title, task.memo, task.url,
                   task.color, remaining, cloneOrder, task.repeat_days),
        ]);

        // Renormalize order
        const allRows = (await db.prepare('SELECT id FROM tasks WHERE user_id=? AND date=? ORDER BY task_order ASC').bind(userId, task.date).all()).results;
        const reorderStmts = allRows.map((r, i) =>
            db.prepare('UPDATE tasks SET task_order=? WHERE id=? AND user_id=?').bind(i, r.id, userId)
        );
        if (reorderStmts.length) await db.batch(reorderStmts);

        const updatedRows = (await db.prepare('SELECT * FROM tasks WHERE user_id=? AND date=? ORDER BY task_order').bind(userId, task.date).all()).results;
        return json({ ok: true, tasks: updatedRows.map(taskRowToJs) });
    }

    if (action === 'migrate_past') {
        const today = data.today || '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return json({ ok: false, error: '日付形式が不正です' }, 400);

        // Force-end overdue started tasks
        const overdues = (await db.prepare(
            'SELECT id, date, start_time FROM tasks WHERE user_id=? AND date<? AND done=0 AND start_time>0'
        ).bind(userId, today).all()).results;

        const endStmts = overdues.map(task => {
            const endOfDay = new Date(`${task.date}T23:59:00+09:00`).getTime();
            const actual   = Math.max(1, Math.round((endOfDay - task.start_time) / 60000));
            return db.prepare('UPDATE tasks SET done=1, actual=? WHERE id=?').bind(actual, task.id);
        });
        if (endStmts.length) await db.batch(endStmts);

        // Migrate undone non-waiting tasks (no template conflict)
        const toMigrate = (await db.prepare(
            `SELECT id, template_id FROM tasks WHERE user_id=? AND date<? AND done=0 AND start_time=0 AND waiting=0`
        ).bind(userId, today).all()).results;

        const migrateStmts = [];
        for (const task of toMigrate) {
            if (task.template_id) {
                const conflict = await db.prepare(
                    'SELECT 1 FROM tasks WHERE user_id=? AND template_id=? AND date=?'
                ).bind(userId, task.template_id, today).first();
                if (conflict) continue;
            }
            migrateStmts.push(db.prepare('UPDATE tasks SET date=? WHERE id=? AND user_id=?').bind(today, task.id, userId));
        }
        if (migrateStmts.length) await db.batch(migrateStmts);

        return json({ ok: true, updated: migrateStmts.length, forcedEnded: overdues.length });
    }

    if (action === 'get_settings') {
        const rows = (await db.prepare('SELECT key, value FROM user_settings WHERE user_id=?').bind(userId).all()).results;
        const settings = {};
        for (const r of rows) settings[r.key] = r.value;
        return json(settings);
    }

    if (action === 'save_setting') {
        const key   = data.key   || '';
        const value = data.value ?? '';
        if (!key) return json({ ok: false }, 400);
        await db.prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?,?,?)').bind(userId, key, value).run();
        return json({ ok: true });
    }

    return json({ ok: false, error: '不正なアクション' }, 400);
}
