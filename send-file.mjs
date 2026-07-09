#!/usr/bin/env node
// One-off script to upload PDF to Feishu and send to group
import * as lark from '@larksuiteoapi/node-sdk';
import { readFile } from 'node:fs/promises';
import { createReadStream as crs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
  const v = process.env[k];
  if (v && /127\.0\.0\.1|localhost|::1/.test(v)) delete process.env[k];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_FILE = path.join(__dirname, 'app.json');
const { app_id, app_secret } = JSON.parse(await readFile(APP_FILE, 'utf8'));

const client = new lark.Client({
  appId: app_id,
  appSecret: app_secret,
  loggerLevel: lark.LoggerLevel.warn,
});

// Upload file to Feishu
const filePath = process.argv[2];
const fileName = path.basename(filePath);
const chatId = process.argv[3]; // chat_id to send to, OR
const replyTo = process.argv[4]; // message_id to reply to

// Per Feishu open platform: file_type ∈ {doc, xls, ppt, pdf, mp4, opus, stream}.
// Auto-detect by extension; fall back to 'stream' for unknown formats. The
// hardcoded 'pdf' default would break .pptx / .docx / .xlsx uploads.
function detectFileType(name) {
  const ext = (path.extname(name) || '').slice(1).toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'doc' || ext === 'docx') return 'doc';
  if (ext === 'xls' || ext === 'xlsx') return 'xls';
  if (ext === 'ppt' || ext === 'pptx') return 'ppt';
  if (ext === 'mp4') return 'mp4';
  if (ext === 'opus') return 'opus';
  return 'stream';
}
const fileType = detectFileType(fileName);

console.log(`Uploading ${fileName} (file_type=${fileType})...`);

// Use the files/upload API for general files
const uploadRes = await client.im.v1.file.create({
  data: {
    file_type: fileType,
    file_name: fileName,
    file: crs(filePath),
  },
});

// SDK returns data directly when successful (no code wrapper)
const fileKey = uploadRes?.data?.file_key ?? uploadRes?.file_key;
if (!fileKey) {
  console.error('Upload failed:', uploadRes);
  process.exit(1);
}
console.log('Uploaded, file_key:', fileKey);

// Send file message to chat or reply thread
let res;
if (replyTo) {
  res = await client.im.v1.message.reply({
    path: { message_id: replyTo },
    data: {
      msg_type: 'file',
      content: JSON.stringify({ file_key: fileKey }),
    },
  });
} else if (chatId) {
  res = await client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'file',
      content: JSON.stringify({ file_key: fileKey }),
    },
  });
} else {
  console.error('Send failed: must provide chat_id or reply_to');
  process.exit(2);
}

if (res?.code && res.code !== 0) {
  console.error('Send failed:', res);
  process.exit(1);
}
console.log('Sent! message_id:', res?.data?.message_id);
