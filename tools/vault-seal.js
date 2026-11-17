'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PRIVATE_DIR = path.join(ROOT, '_private');
const OUTPUT = path.join(ROOT, 'source', 'private-vault.json');
const ITERATIONS = 310000;
const MIN_PASSWORD = 10;

function formatDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return formatDate(new Date(text));
}

function parseEntry(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const stat = fs.statSync(file);
  const front = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = {};
  let body = raw;

  if (front) {
    body = raw.slice(front[0].length);
    front[1].split(/\r?\n/).forEach((line) => {
      const pair = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (!pair) return;
      let value = pair[2].trim();
      if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
      meta[pair[1].toLowerCase()] = value;
    });
  }

  const base = path.basename(file, path.extname(file));
  const fileDate = (base.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1];
  const title = meta.title || base.replace(/^\d{4}-\d{2}-\d{2}[\s_-]*/, '').trim() || '无题';

  return {
    title,
    date: formatDate(meta.date) || formatDate(fileDate) || formatDate(stat.mtime) || '1970-01-01',
    body: body.trim()
  };
}

function collectEntries() {
  if (!fs.existsSync(PRIVATE_DIR)) {
    fs.mkdirSync(PRIVATE_DIR, { recursive: true });
    throw new Error('已创建 _private/，把日记（.md）放进去后重新运行。');
  }

  const files = fs.readdirSync(PRIVATE_DIR)
    .filter((name) => name.endsWith('.md') && !name.startsWith('.'))
    .map((name) => path.join(PRIVATE_DIR, name));

  if (!files.length) throw new Error('_private/ 里还没有 .md 日记。');

  return files
    .map(parseEntry)
    .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title, 'zh-CN'));
}

function seal(password) {
  const entries = collectEntries();
  const payload = Buffer.from(JSON.stringify({ v: 1, entries }), 'utf8');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(data.subarray(-16));
  const roundtrip = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
  if (!roundtrip.equals(payload)) throw new Error('加密自检失败，未写入文件。');

  const vault = {
    v: 1,
    alg: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iter: ITERATIONS,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    data: data.toString('base64')
  };

  const tmp = `${OUTPUT}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(vault), 'utf8');
  fs.renameSync(tmp, OUTPUT);

  return { count: entries.length, bytes: fs.statSync(OUTPUT).size };
}

function askHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    if (!stdin.isTTY) {
      reject(new Error('请在终端里直接运行，不要在管道/后台任务里执行。'));
      return;
    }

    stdout.write(question);
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');

    let value = '';
    const finish = (error) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          finish();
          return;
        }
        if (ch === '\u0003') {
          finish(new Error('已取消。'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
        } else if (ch >= ' ') {
          value += ch;
        }
      }
    };

    stdin.on('data', onData);
  });
}

async function main() {
  const password = await askHidden('设置密码（输入不回显）: ');
  if (password.length < MIN_PASSWORD) {
    throw new Error(`密码至少 ${MIN_PASSWORD} 个字符，建议用四五个词组成一句长口令。`);
  }

  const result = seal(password);
  const kb = (result.bytes / 1024).toFixed(1);
  console.log(`已加密 ${result.count} 篇 → source/private-vault.json（${kb} KB）`);
  console.log('密码没有保存在任何地方，忘了只能带着 _private/ 明文重新 seal。');
  console.log('提交并 push 后才会出现在线上；内容更新也要重新 seal。');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n错误: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { seal, collectEntries, parseEntry };
