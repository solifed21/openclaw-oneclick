import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const cfgPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');

function readCfg() {
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

function writeCfg(cfg) {
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  fs.copyFileSync(cfgPath, `${cfgPath}.bak.${ts}`);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return ts;
}

function maskSecret(v) {
  const s = String(v || '');
  if (!s) return s;
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}${'*'.repeat(Math.max(4, s.length - 8))}${s.slice(-4)}`;
}

function redactSecrets(input) {
  if (Array.isArray(input)) return input.map(redactSecrets);
  if (!input || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const lower = k.toLowerCase();
    if (['token', 'apikey', 'api_key', 'secret', 'password'].includes(lower)) {
      out[k] = maskSecret(v);
      continue;
    }
    out[k] = redactSecrets(v);
  }
  return out;
}

function getAgentRoutes(cfg) {
  const routing = Array.isArray(cfg?.bindings) ? cfg.bindings : [];
  const guilds = cfg?.channels?.discord?.guilds || {};
  const oneclickMeta = cfg?.meta?.oneclick || {};
  const savedPolicies = oneclickMeta?.agentPolicies || {};

  const byAgent = new Map();
  for (const b of routing) {
    if (b?.match?.channel !== 'discord') continue;
    if (b?.match?.peer?.kind !== 'channel') continue;

    const guildId = b?.match?.guildId;
    const channelId = b?.match?.peer?.id;
    if (!guildId || !channelId) continue;

    const agentId = b.agentId || 'main';
    if (!byAgent.has(agentId)) {
      byAgent.set(agentId, {
        agentId,
        accountId: b?.match?.accountId || 'global-ops',
        policy: {
          requireMention: true,
          allowFromBots: false,
          maxBotTurns: 3,
          cooldownSec: 15,
          loopSensitivity: 3,
          ...(savedPolicies?.[agentId] || {}),
        },
        channels: [],
      });
    }

    const route = byAgent.get(agentId);
    const requireMention =
      guilds?.[guildId]?.channels?.[channelId]?.requireMention ??
      guilds?.[guildId]?.requireMention ??
      route.policy.requireMention ??
      true;

    route.channels.push({ guildId, channelId, requireMention });
  }

  const routes = [...byAgent.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
  for (const route of routes) {
    const guildMap = new Map();
    for (const ch of route.channels) {
      if (!guildMap.has(ch.guildId)) guildMap.set(ch.guildId, []);
      guildMap.get(ch.guildId).push({ channelId: ch.channelId, requireMention: ch.requireMention });
    }
    route.guilds = [...guildMap.entries()].map(([guildId, channels]) => ({ guildId, channels }));
  }
  return routes;
}

app.get('/api/state', (_req, res) => {
  try {
    const cfg = readCfg();
    const list = cfg?.agents?.list || [{ id: 'main' }, { id: 'global-ops' }];
    const models = Object.keys(cfg?.agents?.defaults?.models || { 'openai-codex/gpt-5.3-codex': {} });
    const accounts = cfg?.channels?.discord?.accounts || {};
    const agentRoutes = getAgentRoutes(cfg).map((route) => ({
      ...route,
      model: (list.find((a) => a.id === route.agentId)?.model) || models[0],
      tokenConfigured: Boolean(accounts?.[route.accountId || '']?.token),
    }));

    const bindings = agentRoutes.flatMap((r) => r.channels.map((c) => ({
      guildId: c.guildId,
      channelId: c.channelId,
      agent: r.agentId,
      accountId: r.accountId,
      requireMention: c.requireMention,
    })));

    const sanitizedConfig = redactSecrets(cfg);
    res.json({ agents: list, models, bindings, agentRoutes, rawMeta: cfg.meta || {}, config: sanitizedConfig });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

function normalizeRowsToAgents(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    const { agentId, model, guildId, channelId, accountId, token, policy } = row || {};
    if (!agentId || !model || !guildId || !channelId) continue;

    if (!grouped.has(agentId)) {
      grouped.set(agentId, {
        agentId,
        model,
        accountId,
        token,
        policy: policy || {},
        channels: [],
      });
    }

    const item = grouped.get(agentId);
    if (!item.accountId && accountId) item.accountId = accountId;
    if (!item.token && token) item.token = token;
    item.channels.push({ guildId, channelId, requireMention: policy?.requireMention });
  }
  return [...grouped.values()];
}

app.post('/api/apply', (req, res) => {
  try {
    const { discordToken, accountId = 'global-ops', rows = [], agents = [] } = req.body || {};
    const normalizedAgents = Array.isArray(agents) && agents.length > 0
      ? agents
      : normalizeRowsToAgents(rows);

    if (!Array.isArray(normalizedAgents) || normalizedAgents.length === 0) {
      throw new Error('agents(또는 rows) 필수');
    }

    const cfg = readCfg();
    cfg.agents ??= {};
    cfg.agents.defaults ??= {};
    cfg.agents.defaults.models ??= {};
    cfg.agents.list ??= [{ id: 'main' }, { id: 'global-ops' }];

    const merged = new Map(cfg.agents.list.map((a) => [a.id, a]));
    const newDiscordChannelBindings = [];
    const savedPolicies = {};

    cfg.channels ??= {};
    cfg.channels.discord ??= { enabled: true };
    cfg.channels.discord.enabled = true;
    cfg.channels.discord.accounts ??= {};
    cfg.channels.discord.guilds ??= {};

    for (const agent of normalizedAgents) {
      const { agentId, model, channels = [], guilds = [], policy = {} } = agent || {};
      if (!agentId || !model) continue;

      const expandedChannels = Array.isArray(channels) && channels.length > 0
        ? channels
        : (Array.isArray(guilds)
            ? guilds.flatMap((g) => (g?.channels || []).map((c) => ({
                guildId: g?.guildId,
                channelId: c?.channelId,
                requireMention: c?.requireMention,
              })))
            : []);

      cfg.agents.defaults.models[model] ??= {};
      merged.set(agentId, {
        ...(merged.get(agentId) || {}),
        id: agentId,
        model,
        workspace: `${os.homedir()}/.openclaw/workspace-${agentId.replace(/[:/]/g, '-')}`,
      });

      const rowAccountId = agent.accountId || accountId || 'global-ops';
      const existingAccountToken = cfg.channels.discord.accounts?.[rowAccountId]?.token;
      const rowToken = agent.token || discordToken || existingAccountToken;
      if (!rowToken) throw new Error(`token 누락: ${agentId} (기본/에이전트 입력 또는 기존 accountId 토큰 필요)`);
      cfg.channels.discord.accounts[rowAccountId] = { token: rowToken, enabled: true };

      const effectivePolicy = {
        requireMention: policy?.requireMention ?? true,
        allowFromBots: policy?.allowFromBots ?? false,
        maxBotTurns: Number(policy?.maxBotTurns ?? 3),
        cooldownSec: Number(policy?.cooldownSec ?? 15),
        loopSensitivity: Number(policy?.loopSensitivity ?? 3),
      };
      savedPolicies[agentId] = effectivePolicy;

      for (const ch of expandedChannels) {
        const guildId = ch?.guildId?.trim?.() || '';
        const channelId = ch?.channelId?.trim?.() || '';
        if (!guildId || !channelId) continue;

        const requireMention = ch?.requireMention ?? effectivePolicy.requireMention;

        cfg.channels.discord.guilds[guildId] ??= { channels: {} };
        cfg.channels.discord.guilds[guildId].channels ??= {};
        cfg.channels.discord.guilds[guildId].channels[channelId] = {
          allow: true,
          requireMention,
        };

        newDiscordChannelBindings.push({
          agentId,
          match: {
            channel: 'discord',
            accountId: rowAccountId,
            guildId,
            peer: { kind: 'channel', id: channelId },
          },
        });
      }
    }

    if (newDiscordChannelBindings.length === 0) {
      throw new Error('유효한 channels가 없습니다. guildId/channelId 확인 필요');
    }

    cfg.bindings = [
      ...((Array.isArray(cfg.bindings) ? cfg.bindings : []).filter(
        (b) => !(b?.match?.channel === 'discord' && b?.match?.peer?.kind === 'channel')
      )),
      ...newDiscordChannelBindings,
    ];

    cfg.agents.list = [...merged.values()];
    cfg.meta ??= {};
    cfg.meta.oneclick ??= {};
    cfg.meta.oneclick.agentPolicies = savedPolicies;
    cfg.meta.lastTouchedAt = new Date().toISOString();

    const backupTs = writeCfg(cfg);

    const bin = fs.existsSync('/Users/ihansol/.nvm/versions/node/v22.22.0/bin/openclaw')
      ? '/Users/ihansol/.nvm/versions/node/v22.22.0/bin/openclaw'
      : 'openclaw';
    execSync(`${bin} gateway restart`, { stdio: 'pipe' });

    res.json({
      ok: true,
      backup: `${cfgPath}.bak.${backupTs}`,
      summary: {
        agents: normalizedAgents.length,
        channels: newDiscordChannelBindings.length,
      },
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e) });
  }
});

const port = 8787;
app.listen(port, () => {
  console.log(`OpenClaw oneclick console: http://127.0.0.1:${port}`);
});
