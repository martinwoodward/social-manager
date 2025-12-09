// ═══════════════════════════════════════════════════════════════════════════
// Provider Configuration
// Set these in your app before loading, or use the Settings panel
// window.socialConfig = {
//   twitter: { bearerToken: "...", apiKey: "...", apiSecret: "...", accessToken: "...", accessSecret: "..." },
//   bluesky: { handle: "you.bsky.social", appPassword: "xxxx-xxxx-xxxx-xxxx" },
//   linkedin: { accessToken: "..." },
//   threads: { accessToken: "..." }
// }
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// Safari-Compatible LocalStorage Helper
// Handles private browsing mode and quota exceeded errors
// ═══════════════════════════════════════════════════════════════════════════
const storageAvailable = () => {
  try {
    const test = "__storage_test__";
    localStorage.setItem(test, test);
    localStorage.removeItem(test);
    return true;
  } catch (e) {
    return false;
  }
};

const safeGetItem = (key, defaultValue) => {
  if (!storageAvailable()) {
    console.warn("localStorage not available (Safari private browsing?)");
    return defaultValue;
  }
  try {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) : defaultValue;
  } catch (e) {
    console.error(`Error reading ${key} from localStorage:`, e);
    return defaultValue;
  }
};

const safeSetItem = (key, value) => {
  if (!storageAvailable()) {
    console.warn("localStorage not available (Safari private browsing?)");
    return false;
  }
  try {
    const serialized = JSON.stringify(value);
    // Check if we're approaching quota (Safari has ~5-10MB limit)
    if (serialized.length > 4 * 1024 * 1024) {
      console.warn(`${key} data is very large (${(serialized.length / 1024 / 1024).toFixed(2)}MB)`);
    }
    localStorage.setItem(key, serialized);
    return true;
  } catch (e) {
    if (e.name === "QuotaExceededError" || e.code === 22) {
      console.error(`localStorage quota exceeded for ${key}`);
      // Try to clear old data to make room
      try {
        localStorage.removeItem("sm_cache");
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e2) {
        console.error("Failed to save even after clearing cache:", e2);
      }
    } else {
      console.error(`Error writing ${key} to localStorage:`, e);
    }
    return false;
  }
};

const config = () => window.socialConfig || loadStoredConfig();
const loadStoredConfig = () => safeGetItem("sm_config", {});
const saveConfig = (cfg) => {
  const success = safeSetItem("sm_config", cfg);
  if (!success) {
    alert("Unable to save settings. Safari private browsing may prevent storage.");
  }
  return success;
};

// Search presets stored separately
const loadSearchPresets = () => safeGetItem("sm_searches", []);
const saveSearchPresets = (list) => safeSetItem("sm_searches", list);

// Default search presets
const defaultSearchPresets = [
  { label: "Hiring", query: "hiring OR recruiting OR job" },
  { label: "Launches", query: "launching OR shipped OR released" },
  { label: "DevTools", query: "devtools OR developer tools OR DX" },
  { label: "AI/ML", query: "AI OR machine learning OR LLM" },
  { label: "Open Source", query: "open source OR OSS OR github" },
];

// ═══════════════════════════════════════════════════════════════════════════
// TWITTER / X API v2
// Docs: https://developer.twitter.com/en/docs/twitter-api
// ═══════════════════════════════════════════════════════════════════════════
const TwitterClient = {
  name: "twitter",
  baseUrl: "https://api.twitter.com/2",

  headers() {
    const cfg = config().twitter || {};
    if (!cfg.bearerToken) return null;
    return { Authorization: `Bearer ${cfg.bearerToken}`, "Content-Type": "application/json" };
  },

  async search(query) {
    const h = this.headers();
    if (!h) throw new Error("Twitter not configured");
    const params = new URLSearchParams({
      query: query || "lang:en -is:retweet",
      max_results: "20",
      "tweet.fields": "author_id,created_at,public_metrics,conversation_id",
      expansions: "author_id",
      "user.fields": "name,username,profile_image_url",
    });
    const res = await fetch(`${this.baseUrl}/tweets/search/recent?${params}`, { headers: h });
    if (!res.ok) throw new Error(`Twitter ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const users = Object.fromEntries((json.includes?.users || []).map((u) => [u.id, u]));
    return (json.data || []).map((t) => {
      const user = users[t.author_id] || {};
      return {
        id: t.id,
        author: user.name || "Unknown",
        handle: user.username || "unknown",
        text: t.text,
        time: relativeTime(t.created_at),
        url: `https://twitter.com/${user.username}/status/${t.id}`,
        conversationId: t.conversation_id,
        metrics: t.public_metrics,
      };
    });
  },

  async post({ text, inReplyTo }) {
    const h = this.headers();
    if (!h) return { ok: false, error: "Twitter not configured" };
    const body = { text };
    if (inReplyTo) {
      const match = inReplyTo.match(/status\/(\d+)/);
      if (match) body.reply = { in_reply_to_tweet_id: match[1] };
    }
    const res = await fetch(`${this.baseUrl}/tweets`, {
      method: "POST", headers: h, body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `Twitter post ${res.status}` };
    const json = await res.json();
    return { ok: true, url: `https://twitter.com/i/status/${json.data?.id}` };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// BLUESKY / AT Protocol
// Docs: https://atproto.com/docs
// ═══════════════════════════════════════════════════════════════════════════
const BlueskyClient = {
  name: "bluesky",
  baseUrl: "https://bsky.social/xrpc",
  session: null,

  async authenticate() {
    const cfg = config().bluesky || {};
    if (!cfg.handle || !cfg.appPassword) throw new Error("Bluesky not configured");
    if (this.session && Date.now() < this.session.expiresAt) return this.session;
    const res = await fetch(`${this.baseUrl}/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: cfg.handle, password: cfg.appPassword }),
    });
    if (!res.ok) throw new Error(`Bluesky auth ${res.status}`);
    const json = await res.json();
    this.session = { ...json, expiresAt: Date.now() + 3600_000 };
    return this.session;
  },

  async search(query) {
    const sess = await this.authenticate();
    const params = new URLSearchParams({ q: query || "*", limit: "25" });
    const res = await fetch(`${this.baseUrl}/app.bsky.feed.searchPosts?${params}`, {
      headers: { Authorization: `Bearer ${sess.accessJwt}` },
    });
    if (!res.ok) throw new Error(`Bluesky search ${res.status}`);
    const json = await res.json();
    return (json.posts || []).map((p) => ({
      id: p.uri,
      author: p.author?.displayName || p.author?.handle || "Unknown",
      handle: p.author?.handle || "unknown",
      text: p.record?.text || "",
      time: relativeTime(p.record?.createdAt || p.indexedAt),
      url: `https://bsky.app/profile/${p.author?.handle}/post/${p.uri.split("/").pop()}`,
      cid: p.cid,
      uri: p.uri,
    }));
  },

  async post({ text, inReplyTo }) {
    const sess = await this.authenticate();
    const record = {
      $type: "app.bsky.feed.post",
      text,
      createdAt: new Date().toISOString(),
    };
    // If replying, we need parent ref
    if (inReplyTo && state.selectedMessage?.uri && state.selectedMessage?.cid) {
      record.reply = {
        root: { uri: state.selectedMessage.uri, cid: state.selectedMessage.cid },
        parent: { uri: state.selectedMessage.uri, cid: state.selectedMessage.cid },
      };
    }
    const res = await fetch(`${this.baseUrl}/com.atproto.repo.createRecord`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sess.accessJwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ repo: sess.did, collection: "app.bsky.feed.post", record }),
    });
    if (!res.ok) return { ok: false, error: `Bluesky post ${res.status}` };
    const json = await res.json();
    const rkey = json.uri?.split("/").pop();
    return { ok: true, url: `https://bsky.app/profile/${sess.handle}/post/${rkey}` };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// LINKEDIN API
// Docs: https://learn.microsoft.com/en-us/linkedin/
// Note: Requires OAuth 2.0 access token with appropriate scopes
// ═══════════════════════════════════════════════════════════════════════════
const LinkedInClient = {
  name: "linkedin",
  baseUrl: "https://api.linkedin.com/v2",
  restUrl: "https://api.linkedin.com/rest",

  headers() {
    const cfg = config().linkedin || {};
    if (!cfg.accessToken) return null;
    return {
      Authorization: `Bearer ${cfg.accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
      "LinkedIn-Version": "202312",
    };
  },

  async getProfile() {
    const h = this.headers();
    if (!h) throw new Error("LinkedIn not configured");
    const res = await fetch(`${this.restUrl}/me`, { headers: h });
    if (!res.ok) throw new Error(`LinkedIn profile ${res.status}`);
    return res.json();
  },

  async search(query) {
    const h = this.headers();
    if (!h) throw new Error("LinkedIn not configured");
    // LinkedIn doesn't have a public search API for posts
    // We'll fetch the user's feed instead
    const params = new URLSearchParams({ q: "feedUpdates", count: "20" });
    const res = await fetch(`${this.baseUrl}/feed?${params}`, { headers: h });
    if (!res.ok) {
      // Fall back to mock if feed access denied
      console.warn("LinkedIn feed access limited, using activity");
      return this.getActivity(query);
    }
    const json = await res.json();
    return (json.elements || []).map((el, idx) => ({
      id: el.id || `li-${idx}`,
      author: el.actor?.name || "LinkedIn User",
      handle: el.actor?.vanityName || "user",
      text: el.commentary || el.specificContent?.["com.linkedin.ugc.ShareContent"]?.shareCommentary?.text || "",
      time: relativeTime(el.created?.time),
      url: el.permaLink || `https://linkedin.com/feed/update/${el.id}`,
    })).filter((p) => !query || p.text.toLowerCase().includes(query.toLowerCase()));
  },

  async getActivity(query) {
    // Simplified: return user's own posts
    const h = this.headers();
    const profile = await this.getProfile();
    const urn = profile.id || profile.sub;
    const res = await fetch(`${this.baseUrl}/ugcPosts?q=authors&authors=List(urn:li:person:${urn})&count=10`, { headers: h });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.elements || []).map((p, idx) => ({
      id: p.id,
      author: profile.localizedFirstName + " " + profile.localizedLastName,
      handle: profile.vanityName || "me",
      text: p.specificContent?.["com.linkedin.ugc.ShareContent"]?.shareCommentary?.text || "",
      time: relativeTime(p.created?.time),
      url: `https://linkedin.com/feed/update/${p.id}`,
    })).filter((p) => !query || p.text.toLowerCase().includes(query.toLowerCase()));
  },

  async post({ text }) {
    const h = this.headers();
    if (!h) return { ok: false, error: "LinkedIn not configured" };
    const profile = await this.getProfile();
    const urn = `urn:li:person:${profile.id || profile.sub}`;
    const body = {
      author: urn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text },
          shareMediaCategory: "NONE",
        },
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    };
    const res = await fetch(`${this.baseUrl}/ugcPosts`, {
      method: "POST", headers: h, body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `LinkedIn post ${res.status}` };
    const json = await res.json();
    return { ok: true, url: `https://linkedin.com/feed/update/${json.id}` };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// THREADS API (Meta)
// Docs: https://developers.facebook.com/docs/threads
// ═══════════════════════════════════════════════════════════════════════════
const ThreadsClient = {
  name: "threads",
  baseUrl: "https://graph.threads.net/v1.0",

  headers() {
    const cfg = config().threads || {};
    if (!cfg.accessToken) return null;
    return { "Content-Type": "application/json" };
  },

  token() {
    return config().threads?.accessToken;
  },

  async getUserId() {
    const t = this.token();
    if (!t) throw new Error("Threads not configured");
    const res = await fetch(`${this.baseUrl}/me?fields=id,username&access_token=${t}`);
    if (!res.ok) throw new Error(`Threads user ${res.status}`);
    return res.json();
  },

  async search(query) {
    const t = this.token();
    if (!t) throw new Error("Threads not configured");
    const user = await this.getUserId();
    // Threads API: get user's threads
    const fields = "id,text,timestamp,permalink,username,media_type";
    const res = await fetch(`${this.baseUrl}/${user.id}/threads?fields=${fields}&limit=25&access_token=${t}`);
    if (!res.ok) throw new Error(`Threads feed ${res.status}`);
    const json = await res.json();
    return (json.data || []).map((p) => ({
      id: p.id,
      author: p.username || user.username || "Threads User",
      handle: p.username || user.username || "user",
      text: p.text || "",
      time: relativeTime(p.timestamp),
      url: p.permalink || `https://threads.net/@${user.username}/post/${p.id}`,
      mediaType: p.media_type,
    })).filter((p) => !query || p.text.toLowerCase().includes(query.toLowerCase()));
  },

  async post({ text, gifUrl, inReplyTo }) {
    const t = this.token();
    if (!t) return { ok: false, error: "Threads not configured" };
    const user = await this.getUserId();

    // Step 1: Create media container
    const createParams = new URLSearchParams({
      media_type: gifUrl ? "IMAGE" : "TEXT",
      text,
      access_token: t,
    });
    if (gifUrl) createParams.set("image_url", gifUrl);
    if (inReplyTo) {
      const match = inReplyTo.match(/post\/(\d+)/);
      if (match) createParams.set("reply_to_id", match[1]);
    }

    const createRes = await fetch(`${this.baseUrl}/${user.id}/threads?${createParams}`, { method: "POST" });
    if (!createRes.ok) return { ok: false, error: `Threads create ${createRes.status}` };
    const { id: containerId } = await createRes.json();

    // Step 2: Publish
    const publishRes = await fetch(`${this.baseUrl}/${user.id}/threads_publish?creation_id=${containerId}&access_token=${t}`, { method: "POST" });
    if (!publishRes.ok) return { ok: false, error: `Threads publish ${publishRes.status}` };
    const published = await publishRes.json();
    return { ok: true, url: `https://threads.net/@${user.username}/post/${published.id}` };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════════════════════════
function relativeTime(dateStr) {
  if (!dateStr) return "just now";
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

// ═══════════════════════════════════════════════════════════════════════════
// GitHub Models API
// Docs: https://docs.github.com/en/rest/models
// ═══════════════════════════════════════════════════════════════════════════
const GITHUB_MODELS_API = "https://api.github.com/marketplace_listing/accounts";
const GITHUB_MODELS_LIST = "https://api.github.com/models";

async function fetchGitHubModels(token) {
  if (!token) return [];
  try {
    const res = await fetch(GITHUB_MODELS_LIST, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      console.warn(`GitHub Models API ${res.status}`);
      return getDefaultModels();
    }
    const json = await res.json();
    // Filter to chat/completion capable models
    return (json || []).filter((m) => 
      m.task === "chat-completion" || 
      m.supported_input_modalities?.includes("text")
    ).map((m) => ({
      id: m.name,
      name: m.friendly_name || m.name,
      publisher: m.publisher,
      description: m.summary || m.description || "",
      contextWindow: m.max_input_tokens,
      maxOutput: m.max_output_tokens,
    }));
  } catch (err) {
    console.error("Failed to fetch GitHub models:", err);
    return getDefaultModels();
  }
}

function getDefaultModels() {
  // Fallback list of commonly available models
  return [
    { id: "gpt-4o", name: "GPT-4o", publisher: "OpenAI", description: "Most capable GPT-4 model" },
    { id: "gpt-4o-mini", name: "GPT-4o Mini", publisher: "OpenAI", description: "Fast and efficient" },
    { id: "o1-preview", name: "o1 Preview", publisher: "OpenAI", description: "Reasoning model" },
    { id: "o1-mini", name: "o1 Mini", publisher: "OpenAI", description: "Fast reasoning" },
    { id: "Phi-3.5-mini-instruct", name: "Phi 3.5 Mini", publisher: "Microsoft", description: "Small but capable" },
    { id: "Phi-3.5-MoE-instruct", name: "Phi 3.5 MoE", publisher: "Microsoft", description: "Mixture of experts" },
    { id: "Meta-Llama-3.1-8B-Instruct", name: "Llama 3.1 8B", publisher: "Meta", description: "Open source" },
    { id: "Meta-Llama-3.1-70B-Instruct", name: "Llama 3.1 70B", publisher: "Meta", description: "Large open source" },
    { id: "Mistral-large-2407", name: "Mistral Large", publisher: "Mistral AI", description: "Flagship model" },
    { id: "Codestral-2501", name: "Codestral", publisher: "Mistral AI", description: "Code-focused" },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// Provider Registry
// ═══════════════════════════════════════════════════════════════════════════
const providerClients = {
  twitter: TwitterClient,
  bluesky: BlueskyClient,
  linkedin: LinkedInClient,
  threads: ThreadsClient,
};

const providers = [
  createProvider({ id: "twitter", name: "Twitter / X", badge: "API v2", icon: "fa-brands fa-x-twitter" }),
  createProvider({ id: "bluesky", name: "Bluesky", badge: "AT Proto", icon: "fa-brands fa-bluesky" }),
  createProvider({ id: "linkedin", name: "LinkedIn", badge: "OAuth 2.0", icon: "fa-brands fa-linkedin" }),
  createProvider({ id: "threads", name: "Threads", badge: "Graph API", icon: "fa-brands fa-threads" }),
];

const state = {
  selectedProviders: new Set(),
  feed: [],
  selectedMessage: null,
  gifPref: loadGifs(),
  searchPresets: loadSearchPresets().length ? loadSearchPresets() : defaultSearchPresets,
  installPrompt: null,
  selectedGifCategory: "All",
};

const el = (id) => document.getElementById(id);
const feedEl = el("feed");
const providerGrid = el("providerGrid");
const statusText = el("statusText");
const selectedProviderChip = el("selectedProvider");
const originalText = el("originalText");
const replyText = el("replyText");
const toneSelect = el("toneSelect");
const contentSelect = el("contentSelect");
const gifList = el("gifList");

const debounce = (fn, wait = 350) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
};

function createProvider({ id, name, badge, icon }) {
  const client = providerClients[id];
  return {
    id,
    name,
    badge,
    icon,
    isConfigured: () => {
      const cfg = config()[id] || {};
      switch (id) {
        case "twitter": return !!cfg.bearerToken;
        case "bluesky": return !!(cfg.handle && cfg.appPassword);
        case "linkedin": return !!cfg.accessToken;
        case "threads": return !!cfg.accessToken;
        default: return false;
      }
    },
    async search(query) {
      if (!client) return fallbackMock(id, query);
      try {
        const items = await client.search(query);
        return normalizePosts(items, id);
      } catch (err) {
        console.warn(`${id} search failed:`, err.message);
        return fallbackMock(id, query);
      }
    },
    async post({ text, gifUrl }) {
      if (!client) return { ok: false, error: "No provider client" };
      try {
        return await client.post({ text, gifUrl, inReplyTo: state.selectedMessage?.url });
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  };
}

function normalizePosts(items, provider) {
  return items.map((item, idx) => ({
    id: item.id || `${provider}-${idx}-${Date.now()}`,
    author: item.author || item.user || item.username || "Unknown",
    handle: item.handle || item.username || item.user || provider,
    text: item.text || item.body || "",
    time: item.time || "just now",
    url: item.url || item.permalink || item.link || "#",
    provider,
    // Preserve provider-specific fields for replies
    uri: item.uri,
    cid: item.cid,
    conversationId: item.conversationId,
  }));
}

function fallbackMock(id, query) {
  const sample = mockPosts(id);
  const filtered = query
    ? sample.filter((p) => p.text.toLowerCase().includes(query.toLowerCase()))
    : sample;
  return filtered.map((p, idx) => ({ ...p, id: `${id}-${idx}`, provider: id }));
}

function mockPosts(provider) {
  const shared = [
    {
      author: "Alex Kim",
      handle: "alexk",
      text: "Shipping a tiny tool that autogenerates release notes. Who wants early access?",
      time: "2h",
      url: "https://example.com/post/1",
    },
    {
      author: "Priya N.",
      handle: "priyan",
      text: "Hiring a Staff Frontend Engineer to help us redesign data workflows. DMs open.",
      time: "3h",
      url: "https://example.com/post/2",
    },
    {
      author: "DevTools Daily",
      handle: "devtools",
      text: "Threads: Our caching layer rewrite shaved 40% off tail latencies. Here's the postmortem.",
      time: "6h",
      url: "https://example.com/post/3",
    },
  ];
  const flair = {
    twitter: "— spotted on X",
    bluesky: "— over the sky",
    linkedin: "— on LinkedIn",
    threads: "— via Threads",
  };
  return shared.map((p) => ({ ...p, text: `${p.text} ${flair[provider] || ""}`.trim() }));
}

function renderSearchPresets() {
  const container = el("searchPresets");
  if (!container) return;
  container.innerHTML = "";
  state.searchPresets.forEach((preset, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn ghost btn--small";
    btn.textContent = preset.label;
    btn.addEventListener("click", () => {
      el("searchInput").value = preset.query;
      runSearch(preset.query);
    });
    container.appendChild(btn);
  });
}

function openSettingsModal() {
  const existing = document.querySelector(".modal-overlay");
  if (existing) existing.remove();

  const cfg = config();
  const presets = state.searchPresets;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal modal--wide">
      <h3>⚙️ Settings</h3>
      <div class="settings-tabs">
        <button type="button" class="tab active" data-tab="providers">Providers</button>
        <button type="button" class="tab" data-tab="searches">Search Presets</button>
        <button type="button" class="tab" data-tab="llm">LLM Config</button>
      </div>
      
      <div class="tab-content" data-content="providers">
        <p class="hint">Configure API credentials for each social network.</p>
        <div class="provider-config-list">
          ${providers.map((p) => {
            const provCfg = cfg[p.id] || {};
            const configured = p.isConfigured();
            return `
              <div class="provider-config-item">
                <div class="provider-config-header">
                  <span><i class="${p.icon}"></i> <strong>${p.name}</strong></span>
                  <span class="badge ${configured ? 'badge--ok' : 'badge--warn'}">${configured ? '✓ Connected' : 'Not configured'}</span>
                </div>
                <button type="button" class="btn ghost btn--small" data-configure="${p.id}">Configure</button>
              </div>
            `;
          }).join("")}
        </div>
      </div>

      <div class="tab-content hidden" data-content="searches">
        <p class="hint">Manage your saved search presets. These appear as quick-filter buttons.</p>
        <div id="presetList" class="preset-list">
          ${presets.map((p, idx) => `
            <div class="preset-item" data-idx="${idx}">
              <input type="text" class="preset-label" value="${escapeAttr(p.label)}" placeholder="Label">
              <input type="text" class="preset-query" value="${escapeAttr(p.query)}" placeholder="Search query">
              <button type="button" class="btn ghost btn--small" data-remove="${idx}">✕</button>
            </div>
          `).join("")}
        </div>
        <button type="button" class="btn secondary btn--small" id="addPresetBtn">+ Add Preset</button>
      </div>

      <div class="tab-content hidden" data-content="llm">
        <p class="hint">Configure the GitHub Models endpoint for AI-powered draft generation.</p>
        <label class="stacked">
          <span>API Token (GitHub PAT with models scope)</span>
          <div class="input-row">
            <input type="password" id="llmToken" value="${cfg.llmToken || ''}" placeholder="ghp_xxxxxxxxxxxx">
            <button type="button" class="btn secondary btn--small" id="fetchModelsBtn">Fetch Models</button>
          </div>
        </label>
        <label class="stacked">
          <span>Model</span>
          <select id="llmModel">
            <option value="">Loading models...</option>
          </select>
          <span class="hint" id="modelDescription"></span>
        </label>
        <label class="stacked">
          <span>Inference Endpoint (optional override)</span>
          <input type="text" id="llmEndpoint" value="${cfg.llmEndpoint || ''}" placeholder="https://models.inference.ai.azure.com/chat/completions">
        </label>
      </div>

      <div class="modal__actions">
        <button type="button" class="btn primary" id="saveSettingsBtn">Save All</button>
        <button type="button" class="btn ghost" data-close>Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Tab switching
  overlay.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      overlay.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      overlay.querySelectorAll(".tab-content").forEach((c) => c.classList.add("hidden"));
      tab.classList.add("active");
      overlay.querySelector(`[data-content="${tab.dataset.tab}"]`).classList.remove("hidden");
    });
  });

  // Model selection handling
  const modelSelect = overlay.querySelector("#llmModel");
  const modelDesc = overlay.querySelector("#modelDescription");
  const tokenInput = overlay.querySelector("#llmToken");
  let availableModels = [];

  async function populateModels(token) {
    modelSelect.innerHTML = '<option value="">Loading...</option>';
    availableModels = await fetchGitHubModels(token);
    modelSelect.innerHTML = availableModels.length
      ? availableModels.map((m) => `<option value="${m.id}" ${cfg.llmModel === m.id ? 'selected' : ''}>${m.name} (${m.publisher})</option>`).join('')
      : '<option value="gpt-4o-mini">gpt-4o-mini (default)</option>';
    // Set saved model if exists
    if (cfg.llmModel && availableModels.find((m) => m.id === cfg.llmModel)) {
      modelSelect.value = cfg.llmModel;
    }
    updateModelDescription();
  }

  function updateModelDescription() {
    const selected = availableModels.find((m) => m.id === modelSelect.value);
    if (selected) {
      let desc = selected.description;
      if (selected.contextWindow) desc += ` • ${(selected.contextWindow / 1000).toFixed(0)}k context`;
      modelDesc.textContent = desc;
    } else {
      modelDesc.textContent = '';
    }
  }

  modelSelect.addEventListener("change", updateModelDescription);

  overlay.querySelector("#fetchModelsBtn").addEventListener("click", async () => {
    const token = tokenInput.value.trim();
    if (!token) {
      alert("Enter your GitHub token first");
      return;
    }
    await populateModels(token);
  });

  // Initial model population
  if (cfg.llmToken) {
    populateModels(cfg.llmToken);
  } else {
    // Show defaults
    availableModels = getDefaultModels();
    modelSelect.innerHTML = availableModels.map((m) => 
      `<option value="${m.id}" ${cfg.llmModel === m.id ? 'selected' : ''}>${m.name} (${m.publisher})</option>`
    ).join('');
    updateModelDescription();
  }

  // Provider configure buttons
  overlay.querySelectorAll("[data-configure]").forEach((btn) => {
    btn.addEventListener("click", () => {
      overlay.remove();
      openConfigModal(btn.dataset.configure);
    });
  });

  // Add preset
  overlay.querySelector("#addPresetBtn").addEventListener("click", () => {
    const list = overlay.querySelector("#presetList");
    const idx = list.children.length;
    const div = document.createElement("div");
    div.className = "preset-item";
    div.dataset.idx = idx;
    div.innerHTML = `
      <input type="text" class="preset-label" value="" placeholder="Label">
      <input type="text" class="preset-query" value="" placeholder="Search query">
      <button type="button" class="btn ghost btn--small" data-remove="${idx}">✕</button>
    `;
    div.querySelector("[data-remove]").addEventListener("click", () => div.remove());
    list.appendChild(div);
  });

  // Remove preset buttons
  overlay.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", () => btn.closest(".preset-item").remove());
  });

  // Save all
  overlay.querySelector("#saveSettingsBtn").addEventListener("click", () => {
    // Save search presets
    const presetItems = overlay.querySelectorAll(".preset-item");
    const newPresets = [];
    presetItems.forEach((item) => {
      const label = item.querySelector(".preset-label").value.trim();
      const query = item.querySelector(".preset-query").value.trim();
      if (label && query) newPresets.push({ label, query });
    });
    state.searchPresets = newPresets;
    saveSearchPresets(newPresets);

    // Save LLM config
    const newCfg = { ...config() };
    newCfg.llmEndpoint = overlay.querySelector("#llmEndpoint").value.trim();
    newCfg.llmToken = overlay.querySelector("#llmToken").value.trim();
    newCfg.llmModel = overlay.querySelector("#llmModel").value;
    saveConfig(newCfg);

    // Update global refs for LLM
    if (newCfg.llmEndpoint) window.githubModelsEndpoint = newCfg.llmEndpoint;
    if (newCfg.llmToken) window.githubModelsToken = newCfg.llmToken;
    if (newCfg.llmModel) window.githubModelsModel = newCfg.llmModel;

    overlay.remove();
    renderSearchPresets();
    renderProviders();
    setStatus("Settings saved");
  });

  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
}

function escapeAttr(str) {
  return (str || "").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderProviders() {
  providerGrid.innerHTML = "";
  providers.forEach((p) => {
    const configured = p.isConfigured();
    if (!configured) return; // Only show configured providers
    
    const isActive = state.selectedProviders.has(p.id);
    const wrapper = document.createElement("button");
    wrapper.type = "button";
    wrapper.className = `provider-icon ${isActive ? "active" : ""}`;
    wrapper.title = `${p.name} (click to ${isActive ? "disable" : "enable"})`;
    wrapper.innerHTML = `<i class="${p.icon}"></i>`;
    
    wrapper.addEventListener("click", () => {
      if (state.selectedProviders.has(p.id)) {
        state.selectedProviders.delete(p.id);
        wrapper.classList.remove("active");
      } else {
        state.selectedProviders.add(p.id);
        wrapper.classList.add("active");
      }
      runSearch();
    });
    
    providerGrid.appendChild(wrapper);
  });
  
  // If no providers configured, show helpful message
  if (providerGrid.children.length === 0) {
    const hint = document.createElement("div");
    hint.className = "empty";
    hint.textContent = "Configure providers in Settings to get started";
    providerGrid.appendChild(hint);
  }
}

function openConfigModal(providerId) {
  const existing = document.querySelector(".modal-overlay");
  if (existing) existing.remove();

  const cfg = config()[providerId] || {};
  const fields = {
    twitter: [
      { key: "bearerToken", label: "Bearer Token", type: "password", hint: "From Twitter Developer Portal" },
    ],
    bluesky: [
      { key: "handle", label: "Handle", type: "text", hint: "e.g. you.bsky.social" },
      { key: "appPassword", label: "App Password", type: "password", hint: "Generate at bsky.app/settings/app-passwords" },
    ],
    linkedin: [
      { key: "accessToken", label: "Access Token", type: "password", hint: "OAuth 2.0 token with w_member_social scope" },
    ],
    threads: [
      { key: "accessToken", label: "Access Token", type: "password", hint: "From Meta for Developers" },
    ],
  };

  const providerFields = fields[providerId] || [];
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <h3>Configure ${providerId.charAt(0).toUpperCase() + providerId.slice(1)}</h3>
      <form id="configForm">
        ${providerFields.map((f) => `
          <label class="stacked">
            <span>${f.label}</span>
            <input type="${f.type}" name="${f.key}" value="${cfg[f.key] || ""}" placeholder="${f.hint}">
          </label>
        `).join("")}
        <div class="modal__actions">
          <button type="submit" class="btn primary">Save</button>
          <button type="button" class="btn ghost" data-close>Cancel</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const newCfg = { ...config() };
    newCfg[providerId] = {};
    providerFields.forEach((f) => {
      const val = formData.get(f.key);
      if (val) newCfg[providerId][f.key] = val;
    });
    saveConfig(newCfg);
    overlay.remove();
    renderProviders();
    setStatus(`${providerId} configured`);
  });
}

async function runSearch(query = el("searchInput").value.trim()) {
  const active = providers.filter((p) => state.selectedProviders.has(p.id));
  if (!active.length) {
    feedEl.innerHTML = `<div class="empty">Choose at least one provider</div>`;
    setStatus("Idle");
    return;
  }

  const configured = active.filter((p) => p.isConfigured());
  const unconfigured = active.filter((p) => !p.isConfigured());

  if (configured.length) {
    setStatus(`Searching ${configured.map((p) => p.name).join(", ")}…`);
  } else {
    setStatus("Using demo data (configure providers for live feeds)");
  }

  const results = await Promise.all(
    active.map(async (p) => {
      try {
        const posts = await p.search(query);
        // Tag posts from unconfigured providers
        if (!p.isConfigured()) {
          posts.forEach((post) => post.isDemo = true);
        }
        return posts;
      } catch (err) {
        console.error(`Search failed for ${p.id}`, err);
        return [];
      }
    })
  );

  state.feed = results.flat();
  // Sort: real posts first, then demo
  state.feed.sort((a, b) => (a.isDemo === b.isDemo ? 0 : a.isDemo ? 1 : -1));
  renderFeed();

  const realCount = state.feed.filter((p) => !p.isDemo).length;
  const demoCount = state.feed.filter((p) => p.isDemo).length;
  if (realCount && demoCount) {
    setStatus(`${realCount} live + ${demoCount} demo posts`);
  } else if (realCount) {
    setStatus(`Loaded ${realCount} posts`);
  } else {
    setStatus(`${demoCount} demo posts (configure providers for live data)`);
  }
}

function renderFeed() {
  if (!state.feed.length) {
    feedEl.innerHTML = `<div class="empty">No results yet. Try a broader query or refresh.</div>`;
    return;
  }
  feedEl.innerHTML = "";
  state.feed.forEach((post) => {
    const card = document.createElement("article");
    card.className = `card ${post.isDemo ? 'card--demo' : ''}`;
    card.innerHTML = `
      <div class="card__meta">
        <div><strong>${escapeHtml(post.author)}</strong> · @${escapeHtml(post.handle)}</div>
        <div class="card__badges">
          ${post.isDemo ? '<span class="badge badge--demo">Demo</span>' : ''}
          <span class="chip">${post.provider}</span>
        </div>
      </div>
      <p>${escapeHtml(post.text)}</p>
      <div class="card__meta">
        <span>${post.time}</span>
        <div class="card__actions">
          <button class="btn secondary" data-action="reply">Reply</button>
          <button class="btn ghost" data-action="copy">Copy text</button>
          <a class="btn ghost" href="${post.url}" target="_blank" rel="noreferrer">Open</a>
        </div>
      </div>
    `;
    card.querySelector("[data-action='reply']").addEventListener("click", () => selectPost(post));
    card.querySelector("[data-action='copy']").addEventListener("click", () => copyText(post.text));
    feedEl.appendChild(card);
  });
}

function selectPost(post) {
  state.selectedMessage = post;
  originalText.value = post.text;
  selectedProviderChip.textContent = `${post.provider.toUpperCase()} · @${post.handle}`;
  if (el("autoDraftToggle").checked) draftReply();
}

async function draftReply() {
  const prompt = buildPrompt();
  setStatus("Drafting with GitHub models…");
  const contentType = contentSelect.value;
  try {
    const result = await callGitHubModel(prompt, contentType === "gif");
    replyText.value = result.text;
    if (result.gifUrl) replyText.value += `\n\nGIF: ${result.gifUrl}`;
  } catch (err) {
    console.error(err);
    replyText.value = playfulFallback(prompt, contentType === "gif");
  } finally {
    setStatus("Ready");
  }
}

function buildPrompt() {
  const original = originalText.value.trim();
  const tone = toneSelect.value;
  const contentType = contentSelect.value;
  const provider = state.selectedMessage?.provider || "unknown";
  return `You are a witty social media ghostwriter. Provider: ${provider}. Tone: ${tone}. Format: ${contentType === "gif" ? "suggest a GIF and a caption" : "text with tasteful emoji"}. Original post: "${original}".`;
}

async function callGitHubModel(prompt, wantGif) {
  const token = window.githubModelsToken || config().llmToken;
  const model = window.githubModelsModel || config().llmModel || "gpt-4o-mini";
  // Default to GitHub Models inference endpoint, allow override
  const endpoint = window.githubModelsEndpoint || config().llmEndpoint || "https://models.inference.ai.azure.com/chat/completions";
  
  if (!token) return { text: playfulFallback(prompt, wantGif) };
  
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  const body = {
    model,
    messages: [
      { role: "system", content: "You craft brief, warm social replies. Keep it under 280 chars." },
      { role: "user", content: prompt },
    ],
    max_tokens: 180,
    temperature: 0.7,
  };
  const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`GitHub model error: ${res.status}`);
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("No content from model");
  const gifUrl = wantGif ? pickGif()?.url : null;
  return { text, gifUrl };
}

function playfulFallback(prompt, wantGif) {
  const base = `Here is a punchy take: ${prompt.slice(0, 60)}… 🚀`; // keeps it short and upbeat
  const gif = wantGif ? `\nGIF: ${pickGif()?.url || "[add a GIF]"}` : "";
  return `${base}${gif}`;
}

function pickGif() {
  if (!state.gifPref.length) return null;
  return state.gifPref[Math.floor(Math.random() * state.gifPref.length)];
}

function renderGifs() {
  gifList.innerHTML = "";
  
  // Get all unique categories
  const categories = ["All", ...new Set(state.gifPref.map(g => g.category || "General"))];
  
  // Create category filter buttons
  const filterRow = document.createElement("div");
  filterRow.className = "gif-categories";
  categories.forEach(cat => {
    const btn = document.createElement("button");
    btn.className = `btn ghost ${state.selectedGifCategory === cat ? "active" : ""}`;
    btn.textContent = cat;
    btn.dataset.category = cat;
    filterRow.appendChild(btn);
  });
  gifList.appendChild(filterRow);
  
  // Filter GIFs by selected category
  const filtered = state.selectedGifCategory === "All" 
    ? state.gifPref 
    : state.gifPref.filter(g => (g.category || "General") === state.selectedGifCategory);
  
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = state.gifPref.length ? "No GIFs in this category" : "Add your go-to reaction GIFs";
    gifList.appendChild(empty);
    return;
  }
  
  filtered.forEach((gif) => {
    const idx = state.gifPref.indexOf(gif);
    const tile = document.createElement("div");
    tile.className = "gif-tile";
    tile.dataset.gifIndex = idx;
    tile.innerHTML = `<img src="${gif.url}" alt="${gif.label}"><span>${gif.label}</span>`;
    gifList.appendChild(tile);
  });
}

function loadGifs() {
  const stored = safeGetItem("sm_gifs", null);
  if (stored) {
    // Ensure backward compatibility: add default category if missing
    return stored.map(gif => ({
      ...gif,
      category: gif.category || "General"
    }));
  }
  return [
    { url: "https://media.giphy.com/media/3oriO0OEd9QIDdllqo/giphy.gif", label: "Happy dance", category: "Celebration" },
    { url: "https://media.giphy.com/media/l3V0dy1zzyjbYTQQM/giphy.gif", label: "Mic drop", category: "Celebration" },
    { url: "https://media.giphy.com/media/26AHLBZUC1n53ozi8/giphy.gif", label: "Slow clap", category: "Reaction" },
  ];
}

function saveGifs(list) {
  return safeSetItem("sm_gifs", list);
}

function copyText(text) {
  navigator.clipboard?.writeText(text).then(() => setStatus("Copied"));
}

async function handlePost() {
  if (!state.selectedMessage) {
    alert("Select a post first.");
    return;
  }
  const provider = providers.find((p) => p.id === state.selectedMessage.provider);
  if (!provider) return;
  const gifUrl = extractGif(replyText.value);
  setStatus(`Posting to ${provider.id}…`);
  const res = await provider.post({ text: replyText.value, gifUrl });
  if (res.ok) setStatus(`Posted to ${provider.id}`);
  else setStatus(res.error || "Post failed");
}

function extractGif(text) {
  const match = text.match(/GIF:\s*(\S+)/i);
  return match?.[1];
}

function setStatus(msg) {
  statusText.textContent = msg;
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function setupEvents() {
  el("searchInput").addEventListener("input", debounce((e) => runSearch(e.target.value)));
  el("refreshButton").addEventListener("click", () => runSearch());
  el("settingsButton")?.addEventListener("click", openSettingsModal);
  el("draftButton").addEventListener("click", draftReply);
  el("copyButton").addEventListener("click", () => copyText(replyText.value));
  el("postButton").addEventListener("click", handlePost);
  el("clearDraft").addEventListener("click", () => {
    originalText.value = "";
    replyText.value = "";
    state.selectedMessage = null;
    selectedProviderChip.textContent = "No post selected";
  });
  originalText.addEventListener("paste", (e) => {
    if (!el("autoDraftToggle").checked) return;
    setTimeout(draftReply, 30);
  });
  el("addGifButton").addEventListener("click", () => {
    const url = prompt("GIF URL");
    const label = prompt("Label for this GIF");
    if (!url || !label) return;
    const category = prompt("Category (e.g., Celebration, Reaction, Thanks)", "General");
    if (!category || category.trim() === "") return;
    state.gifPref.push({ url, label, category: category.trim() });
    saveGifs(state.gifPref);
    renderGifs();
  });
  
  // Event delegation for GIF list (categories and tiles)
  gifList.addEventListener("click", (e) => {
    const categoryBtn = e.target.closest(".gif-categories button");
    if (categoryBtn) {
      state.selectedGifCategory = categoryBtn.dataset.category;
      renderGifs();
      return;
    }
    
    const gifTile = e.target.closest(".gif-tile");
    if (gifTile) {
      const idx = parseInt(gifTile.dataset.gifIndex, 10);
      const gif = state.gifPref[idx];
      if (gif) {
        replyText.value = `${replyText.value}\n\nGIF: ${gif.url}`.trim();
        setStatus("GIF attached");
      }
    }
  });
  
  gifList.addEventListener("contextmenu", (e) => {
    const gifTile = e.target.closest(".gif-tile");
    if (gifTile) {
      e.preventDefault();
      const idx = parseInt(gifTile.dataset.gifIndex, 10);
      if (confirm("Remove this GIF?")) {
        state.gifPref.splice(idx, 1);
        saveGifs(state.gifPref);
        renderGifs();
      }
    }
  });
}

function setupPWA() {
  if ("serviceWorker" in navigator) {
    const version = window.APP_VERSION || "__APP_VERSION__";
    navigator.serviceWorker
      .register(`./service-worker.js?v=${version}`)
      .then((registration) => {
        if (registration.waiting) {
          registration.waiting.postMessage({ type: "SKIP_WAITING" });
        }
        navigator.serviceWorker.controller?.postMessage({
          type: "SET_VERSION",
          version,
        });
      })
      .catch((err) => console.error("SW", err));
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.installPrompt = e;
    el("installButton").disabled = false;
  });
  el("installButton").addEventListener("click", async () => {
    if (!state.installPrompt) return alert("Install prompt not ready yet");
    state.installPrompt.prompt();
    const choice = await state.installPrompt.userChoice;
    if (choice.outcome === "accepted") setStatus("Installed");
    state.installPrompt = null;
  });
}

function init() {
  // Check Safari localStorage availability
  if (!storageAvailable()) {
    const warning = document.createElement("div");
    warning.className = "alert alert--warning";
    warning.innerHTML = `
      <strong>⚠️ Storage Unavailable</strong>
      <p>Settings cannot be saved in Safari Private Browsing mode. Switch to normal browsing to save your configuration.</p>
    `;
    document.querySelector(".hero").prepend(warning);
    console.warn("localStorage not available - settings will not persist");
  }

  // Load saved LLM config
  const cfg = config();
  if (cfg.llmEndpoint) window.githubModelsEndpoint = cfg.llmEndpoint;
  if (cfg.llmToken) window.githubModelsToken = cfg.llmToken;
  if (cfg.llmModel) window.githubModelsModel = cfg.llmModel;

  // Enable all configured providers by default
  providers.forEach((p) => {
    if (p.isConfigured()) state.selectedProviders.add(p.id);
  });

  renderProviders();
  renderSearchPresets();
  renderGifs();
  setupEvents();
  setupPWA();
  runSearch();
}

init();
