#!/usr/bin/env node
// send-image.mjs — send an inline image to Feishu
// Usage:
//   node send-image.mjs <path> --chat-id <oc_xxx>
//   node send-image.mjs <path> --reply-to <om_xxx>
//   node send-image.mjs <path> --chat-id <oc_xxx> --reply-to <om_xxx>  (reply with image)

for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
  const v = process.env[k];
  if (v && /127\.0\.0\.1|localhost|::1/.test(v)) delete process.env[k];
}

import * as lark from '@larksuiteoapi/node-sdk';
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_FILE = path.join(__dirname, 'app.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = val;
      i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    process.stderr.write(
      'Usage:\n' +
      '  send-image.mjs <image-path> --chat-id <oc_xxx>\n' +
      '  send-image.mjs <image-path> --reply-to <om_xxx>\n' +
      '  send-image.mjs <image-path> --chat-id <oc_xxx> --reply-to <om_xxx>\n',
    );
    process.exit(0);
  }

  // Find the image path from positional args (not starting with --)
  const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
  // Skip args that are values of previous --flags
  const skipValues = new Set();
  for (const key of Object.keys(args)) {
    const val = args[key];
    if (typeof val === 'string') skipValues.add(val);
  }
  const filePath = positional.find(a => !skipValues.has(a) && existsSync(a));

  if (!filePath) {
    process.stderr.write('error: must provide a valid image file path\n');
    process.exit(2);
  }
  if (!existsSync(filePath)) {
    process.stderr.write(`error: file not found: ${filePath}\n`);
    process.exit(1);
  }

  const chatId = args['chat-id'];
  const replyTo = args['reply-to'];
  if (!chatId && !replyTo) {
    process.stderr.write('error: must provide --chat-id or --reply-to\n');
    process.exit(2);
  }

  const fileName = path.basename(filePath);
  const ext = (path.extname(fileName) || '').slice(1).toLowerCase();
  if (!['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) {
    process.stderr.write(`error: unsupported image format: .${ext}\n`);
    process.exit(1);
  }

  if (!existsSync(APP_FILE)) {
    process.stderr.write(`error: ${APP_FILE} missing. Run register first.\n`);
    process.exit(1);
  }
  const { app_id, app_secret } = JSON.parse(await readFile(APP_FILE, 'utf8'));

  const client = new lark.Client({
    appId: app_id,
    appSecret: app_secret,
    loggerLevel: lark.LoggerLevel.warn,
  });

  // Upload image via Feishu image API
  const uploadRes = await client.im.v1.image.create({
    data: {
      image_type: 'message',
      image: createReadStream(filePath),
    },
  });

  const imageKey = uploadRes?.data?.image_key ?? uploadRes?.image_key;
  if (!imageKey) {
    process.stderr.write(`Image upload failed: ${JSON.stringify(uploadRes)}\n`);
    process.exit(1);
  }

  // Send as inline image message
  let res;
  if (replyTo) {
    res = await client.im.v1.message.reply({
      path: { message_id: replyTo },
      data: {
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      },
    });
  } else {
    res = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      },
    });
  }

  if (res?.code && res.code !== 0) {
    process.stderr.write(`Feishu API error code=${res.code} msg=${res.msg}\n`);
    process.exit(1);
  }
  process.stdout.write(
    JSON.stringify({
      ok: true,
      message_id: res?.data?.message_id ?? null,
      image_key: imageKey,
      replied_to: replyTo || null,
    }) + '\n',
  );
}

main().catch((e) => {
  process.stderr.write('send-image failed: ' + (e?.message || e) + '\n');
  process.exit(1);
});
