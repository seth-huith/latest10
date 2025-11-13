// worker.js
// Cloudflare Worker: API + Cron updater for "latest 10" articles per subject
// KV binding required: bind KV namespace as ARTICLES (e.g., in wrangler.toml)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'GET' && path === '/api/articles') {
      const subjects = (url.searchParams.get('subject') || '').split(',').map(s => s.trim()).filter(Boolean);
      if (subjects.length === 0) return json({ error: 'subject query param required, comma-separated' }, 400);

      const out = {};
      for (const subj of subjects) {
        const key = kvKey(subj);
        const raw = await env.ARTICLES.get(key);
        out[subj] = raw ? JSON.parse(raw) : [];
      }
      return json(out);
    }

    if (request.method === 'POST' && path === '/api/articles') {
      // Secure with a bearer token secret
      const auth = request.headers.get('authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token || token !== env.WEBHOOK_TOKEN) return json({ error: 'Unauthorized' }, 401);

      const body = await request.json().catch(() => null);
      if (!body || !body.subject || !Array.isArray(body.items)) {
        return json({ error: 'Body must include { subject, items: [...] }' }, 400);
      }

      const subject = sanitize(body.subject);
      const items = normalizeItems(body.items);
      const key = kvKey(subject);

      const existing = JSON.parse((await env.ARTICLES.get(key)) || '[]');
      const merged = dedupeSortKeep10([...items, ...existing]);
      await env.ARTICLES.put(key, JSON.stringify(merged), { expirationTtl: 60 * 60 * 24 * 7 }); // 7d TTL
      return json({ ok: true, count: merged.length });
    }

    if (request.method === 'GET' && path === '/health') {
      return new Response('ok');
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    // Periodic pull from RSS for configured subjects
    const SUBJECTS = getSubjectsConfig();
    for (const subj of Object.keys(SUBJECTS)) {
      const feeds = SUBJECTS[subj];
      const collected = [];
      for (const feed of feeds) {
        try {
          const res = await fetch(feed, { headers: { 'user-agent': 'latest10-bot/1.0' } });
          const xml = await res.text();
          collected.push(...parseRss(xml, feed));
        } catch (e) {
          // swallow errors per-feed; keep going
        }
      }
      const key = kvKey(subj);
      const existing = JSON.parse((await env.ARTICLES.get(key)) || '[]');
      const merged = dedupeSortKeep10([...collected, ...existing]);
      await env.ARTICLES.put(key, JSON.stringify(merged), { expirationTtl: 60 * 60 * 24 * 7 });
    }
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function kvKey(subject) {
  return `articles:${sanitize(subject)}`;
}

function sanitize(s) { return (s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-'); }

function normalizeItems(items) {
  return items
    .map(i => ({
      title: (i.title || '').trim().slice(0, 240),
      url: (i.url || i.link || '').trim(),
      source: (i.source || i.site || '').trim(),
      publishedAt: toIso(i.publishedAt || i.pubDate || i.date),
      subject: sanitize(i.subject || i.topic || ''),
    }))
    .filter(i => i.title && isHttp(i.url))
}

function dedupeSortKeep10(items) {
  const seen = new Set();
  const unique = [];
  for (const i of items) {
    const key = i.url || i.title;
    if (!seen.has(key)) { seen.add(key); unique.push(i); }
  }
  unique.sort((a, b) => (Date.parse(b.publishedAt || 0) || 0) - (Date.parse(a.publishedAt || 0) || 0));
  return unique.slice(0, 10);
}

function isHttp(u) { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; } }

function toIso(v) {
  if (!v) return new Date().toISOString();
  const d = new Date(v);
  return isNaN(d) ? new Date().toISOString() : d.toISOString();
}

function getSubjectsConfig() {
  // Map each subject to one or more RSS/Atom feeds to aggregate
  return {
    php: [
      "https://www.php.net/feed.atom",                             // official PHP news
      "https://www.reddit.com/r/PHP/.rss",                         // community updates
      "https://stitcher.io/rss",                                   // Laravel/PHP blog
    ],
    symfony: [
      "https://symfony.com/blog/rss.xml",                          // official Symfony blog
      "https://www.reddit.com/r/symfony/.rss",                     // community discussions
    ],
    ai: [
      "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml",
      "https://feeds.arstechnica.com/arstechnica/technology-lab",
      "https://venturebeat.com/category/ai/feed/",
    ],
    industry: [
      "https://feeds.reuters.com/reuters/industrialsNews",          // Reuters industry news
      "https://www.industryweek.com/rss",                           // manufacturing & industrial
    ],
    javascript: [
      "https://javascriptweekly.com/rss/",                          // curated JS weekly
      "https://dev.to/feed/tag/javascript",                         // dev.to JavaScript tag
      "https://2ality.com/feeds/posts.atom",                        // expert blog by Axel Rauschmayer
    ],
  };
}

function parseRss(xml, source) {
  // naive RSS/Atom parse (no external libs). Works for most common feeds.
  // Returns array of { title, url, source, publishedAt }
  const items = [];
  // Try RSS <item>
  const itemRegex = /<item[\s\S]*?<\/item>/g;
  const entries = xml.match(itemRegex) || [];
  if (entries.length) {
    for (const raw of entries) {
      items.push({
        title: pick(raw, /<title>([\s\S]*?)<\/title>/i),
        url: pick(raw, /<link>([\s\S]*?)<\/link>/i),
        source,
        publishedAt: pick(raw, /<pubDate>([\s\S]*?)<\/pubDate>/i) || pick(raw, /<dc:date>([\s\S]*?)<\/dc:date>/i),
      });
    }
    return normalizeItems(items);
  }
  // Try Atom <entry>
  const entryRegex = /<entry[\s\S]*?<\/entry>/g;
  const atoms = xml.match(entryRegex) || [];
  for (const raw of atoms) {
    items.push({
      title: pick(raw, /<title[^>]*>([\s\S]*?)<\/title>/i),
      url: pick(raw, /<link[^>]*href=\"([^\"]+)\"[^>]*\/>/i) || pick(raw, /<id>([\s\S]*?)<\/id>/i),
      source,
      publishedAt: pick(raw, /<updated>([\s\S]*?)<\/updated>/i) || pick(raw, /<published>([\s\S]*?)<\/published>/i),
    });
  }
  return normalizeItems(items);
}

function pick(s, re) {
  const m = s.match(re);
  if (!m) return '';
  return decodeHtml(m[1].trim());
}

function decodeHtml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
/*
curl -X POST "https://twilight-unit-dc87.yogg.workers.dev/api/articles" \
  -H "Authorization: Bearer generate-a-long-random-ass-token" \
  -H "Content-Type: application/json" \
  -d '{"subject":"ai","items":[{"title":"Test post","url":"https://example.com","source":"me","publishedAt":"2025-11-13T12:00:00Z"}]}'

curl -X POST "https://latest10.yogg.workers.dev/api/articles" \
  -H "Authorization: Bearer generate-a-long-random-ass-token" \
  -H "Content-Type: application/json" \
  -d '{"subject":"ai","items":[{"title":"Test post","url":"https://example.com","source":"me","publishedAt":"2025-11-13T12:00:00Z"}]}'

*/