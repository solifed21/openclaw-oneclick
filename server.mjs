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

app.get('/api/state', (_req, res) => {
  try {
    const cfg = readCfg();
    const list = cfg?.agents?.list || [{ id: 'main' }, { id: 'global-ops' }];
    const models = Object.keys(cfg?.agents?.defaults?.models || { 'openai-codex/gpt-5.3-codex': {} });

    const bindings = [];
    const guilds = cfg?.channels?.discord?.guilds || {};
    for (const [guildId, g] of Object.entries(guilds)) {
      for (const [channelId, c] of Object.entries(g?.channels || {})) {
        bindings.push({
          guildId,
          channelId,
          agent: c.agent || 'main',
          accountId: c.accountId || 'global-ops',
          requireMention: c.requireMention ?? true,
          allowFromBots: c.allowFromBots ?? false,
          maxBotTurns: c.maxBotTurns ?? 3,
          cooldownSec: c.cooldownSec ?? 15,
          loopSensitivity: c?.loopGuard?.sensitivity ?? 3
        });
      }
    }

    res.json({ agents: list, models, bindings, rawMeta: cfg.meta || {} });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/apply', (req, res) => {
  try {
    const { discordToken, accountId = 'global-ops', rows = [] } = req.body || {};
    if (!discordToken && !rows.some(r => r?.token)) throw new Error('기본 discordToken 또는 행별 token 중 하나는 필수');
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows 필수');

    const cfg = readCfg();
    cfg.agents ??= {};
    cfg.agents.defaults ??= {};
    cfg.agents.defaults.models ??= {};
    cfg.agents.list ??= [{ id: 'main' }, { id: 'global-ops' }];

    const merged = new Map(cfg.agents.list.map((a) => [a.id, a]));

    for (const row of rows) {
      const { agentId, model, guildId, channelId, policy } = row;
      if (!agentId || !model || !guildId || !channelId) continue;
      cfg.agents.defaults.models[model] ??= {};
      merged.set(agentId, {
        ...(merged.get(agentId) || {}),
        id: agentId,
        model,
        workspace: `${os.homedir()}/.openclaw/workspace-${agentId.replace(/[:/]/g, '-')}`
      });

      const rowAccountId = row.accountId || accountId || 'global-ops';
      const rowToken = row.token || discordToken;

      cfg.channels ??= {};
      cfg.channels.discord ??= { enabled: true };
      cfg.channels.discord.enabled = true;
      cfg.channels.discord.accounts ??= {};
      if (!rowToken) throw new Error(`token 누락: ${agentId}`);
      cfg.channels.discord.accounts[rowAccountId] = { token: rowToken, enabled: true };
      cfg.channels.discord.guilds ??= {};
      cfg.channels.discord.guilds[guildId] ??= { channels: {} };
      cfg.channels.discord.guilds[guildId].channels ??= {};
      cfg.channels.discord.guilds[guildId].channels[channelId] = {
        agent: agentId,
        accountId: rowAccountId,
        requireMention: policy?.requireMention ?? true,
        allowFromBots: policy?.allowFromBots ?? false,
        maxBotTurns: Number(policy?.maxBotTurns ?? 3),
        cooldownSec: Number(policy?.cooldownSec ?? 15),
        loopGuard: { enabled: true, sensitivity: Number(policy?.loopSensitivity ?? 3) }
      };
    }

    cfg.agents.list = [...merged.values()];
    cfg.meta ??= {};
    cfg.meta.lastTouchedAt = new Date().toISOString();

    const backupTs = writeCfg(cfg);

    const bin = fs.existsSync('/Users/ihansol/.nvm/versions/node/v22.22.0/bin/openclaw')
      ? '/Users/ihansol/.nvm/versions/node/v22.22.0/bin/openclaw'
      : 'openclaw';
    execSync(`${bin} gateway restart`, { stdio: 'pipe' });

    res.json({ ok: true, backup: `${cfgPath}.bak.${backupTs}` });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e) });
  }
});

const port = 8787;
app.listen(port, () => {
  console.log(`OpenClaw oneclick console: http://127.0.0.1:${port}`);
});
