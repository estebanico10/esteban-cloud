'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ChatStore, sanitizeFileName } = require('../electron/chat-store.cjs');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'esteban-cloud-chat-test-'));
}

test('ChatStore: create multiple chats, validation, idempotent P2P create, and updatedAt sorting', () => {
  const dir = makeTempDir();
  try {
    const store = new ChatStore(dir);

    assert.throws(
      () => store.createChat({ title: '   ' }),
      (err) => err.statusCode === 400
    );

    const c1 = store.createChat({
      id: 'chat-esteban',
      title: 'Esteban PC',
      type: 'direct',
      peerNode: 'PRO-NICOLA',
      peerUrl: 'http://100.64.0.10:4789'
    });
    const c2 = store.createChat({
      title: 'Notas del Proyecto',
      type: 'notes'
    });

    assert.equal(c1.id, 'chat-esteban');
    assert.equal(c1.title, 'Esteban PC');
    assert.equal(c1.type, 'direct');
    assert.equal(c1.peerNode, 'PRO-NICOLA');
    assert.equal(c1.peerUrl, 'http://100.64.0.10:4789');
    assert.equal(c1.unreadCount, 0);
    assert.equal(c1.messageCount, 0);
    assert.equal(c1.lastMessagePreview, '');
    assert.ok(c2.id.startsWith('chat-'));

    // Idempotent createChat returns existing chat without duplicating
    const c1Again = store.createChat({
      id: 'chat-esteban',
      title: 'Otro titulo ignorado'
    });
    assert.equal(c1Again.id, 'chat-esteban');
    assert.equal(c1Again.title, 'Esteban PC');
    assert.equal(store.listChats().length, 2);

    // Add messages with explicit timestamps to verify updatedAt desc sorting
    store.addMessage({
      chatId: c2.id,
      senderNode: 'LOCAL',
      text: 'Mensaje más antiguo',
      createdAt: '2026-11-20T10:00:00.000Z'
    });
    store.addMessage({
      chatId: c1.id,
      senderNode: 'PRO-NICOLA',
      text: 'Mensaje más reciente',
      createdAt: '2026-11-23T12:00:00.000Z'
    });

    const list = store.listChats();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, c1.id);
    assert.equal(list[1].id, c2.id);
    assert.equal(list[0].messageCount, 1);
    assert.equal(list[0].lastMessagePreview, 'Mensaje más reciente');

    // getChat throws 404 when missing
    assert.throws(
      () => store.getChat('chat-inexistente'),
      (err) => err.statusCode === 404
    );

    // Persistence check across new instance & no leftover .tmp file
    assert.equal(fs.existsSync(path.join(dir, 'chat-data.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'chat-data.json.tmp')), false);
    const reloaded = new ChatStore(dir);
    assert.equal(reloaded.listChats().length, 2);
    assert.equal(reloaded.getChat(c1.id).messages.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ChatStore: rich markdown messages, auto-create chat only with chatTitle, and idempotent message sync', () => {
  const dir = makeTempDir();
  try {
    const store = new ChatStore(dir);

    // Without chatTitle, adding to missing chat must throw 404
    assert.throws(
      () => store.addMessage({
        chatId: 'chat-missing',
        senderNode: 'PEER-A',
        text: 'Hola'
      }),
      (err) => err.statusCode === 404
    );

    // With chatTitle, auto-creates the chat
    const mdText = '# Reporte diario\n\n- **Estado**: OK\n- Código: `npm test`\n\n> Todo sincronizado.';
    const m1 = store.addMessage({
      id: 'msg-sync-001',
      chatId: 'chat-p2p-1',
      chatTitle: 'Aime Laptop',
      senderNode: 'AIME-PC',
      text: mdText,
      format: 'markdown',
      createdAt: '2026-11-23T08:00:00.000Z',
      incoming: true
    });

    assert.equal(m1.id, 'msg-sync-001');
    assert.equal(m1.format, 'markdown');
    assert.equal(m1.text, mdText);
    assert.equal(m1.incoming, true);

    const { chat, messages } = store.getChat('chat-p2p-1');
    assert.equal(chat.title, 'Aime Laptop');
    assert.equal(chat.unreadCount, 1);
    assert.equal(messages.length, 1);

    // Idempotent duplicate message sync must NOT duplicate or increment unreadCount
    const dup = store.addMessage({
      id: 'msg-sync-001',
      chatId: 'chat-p2p-1',
      senderNode: 'AIME-PC',
      text: 'Texto alterado que no debe sobrescribir',
      incoming: true
    });

    assert.equal(dup.id, 'msg-sync-001');
    assert.equal(dup.text, mdText);
    const afterDup = store.getChat('chat-p2p-1');
    assert.equal(afterDup.messages.length, 1);
    assert.equal(afterDup.chat.unreadCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ChatStore: save/read image & file attachments, sanitize names, delete single attachment, delete message, delete chat', () => {
  const dir = makeTempDir();
  try {
    const store = new ChatStore(dir);
    const chat = store.createChat({ id: 'chat-files', title: 'Transferencias' });

    // Filename sanitization against traversal & dangerous chars
    assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeFileName('C:\\Users\\test\\mi<foto>:1?.png'), 'mi_foto__1_.png');

    // Save an image attachment (PNG bytes) and a generic file attachment (PDF bytes)
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
    const pdfBytes = Buffer.from('%PDF-1.4\nEjemplo de documento Esteban Cloud\n%%EOF', 'utf8');
    const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');

    const imgAtt = store.saveAttachment({
      fileName: '../../captura:pantalla.png',
      mime: 'image/png',
      buffer: pngBytes
    });
    const pdfAtt = store.saveAttachment({
      fileName: 'contrato-final.pdf',
      buffer: pdfBytes
    });
    const svgAtt = store.saveAttachment({
      fileName: 'diagrama.svg',
      mime: 'application/octet-stream',
      buffer: svgBytes
    });

    assert.match(imgAtt.id, /^att-[0-9a-f]+$/);
    assert.equal(imgAtt.name, 'captura_pantalla.png');
    assert.equal(imgAtt.mime, 'image/png');
    assert.equal(imgAtt.size, pngBytes.length);
    assert.equal(imgAtt.isImage, true);
    assert.equal(imgAtt.deleted, false);

    assert.equal(pdfAtt.name, 'contrato-final.pdf');
    assert.equal(pdfAtt.mime, 'application/pdf');
    assert.equal(pdfAtt.size, pdfBytes.length);
    assert.equal(pdfAtt.isImage, false);
    assert.equal(pdfAtt.deleted, false);

    // Extension detection for .svg even with octet-stream mime
    assert.equal(svgAtt.isImage, true);

    // Read attachment back via getAttachmentInfo
    const imgInfo = store.getAttachmentInfo(imgAtt.id);
    assert.equal(imgInfo.meta.id, imgAtt.id);
    assert.equal(imgInfo.meta.name, 'captura_pantalla.png');
    assert.equal(imgInfo.meta.isImage, true);
    assert.ok(path.isAbsolute(imgInfo.filePath));
    assert.ok(fs.existsSync(imgInfo.filePath));
    assert.deepEqual(fs.readFileSync(imgInfo.filePath), pngBytes);

    const pdfInfo = store.getAttachmentInfo(pdfAtt.id);
    assert.deepEqual(fs.readFileSync(pdfInfo.filePath), pdfBytes);

    // Attach to messages
    const msg1 = store.addMessage({
      chatId: chat.id,
      senderNode: 'LOCAL',
      text: 'Aquí van la captura y el PDF',
      attachments: [imgAtt, pdfAtt]
    });
    const msg2 = store.addMessage({
      chatId: chat.id,
      senderNode: 'LOCAL',
      text: '',
      attachments: [svgAtt]
    });

    assert.equal(store.getChat(chat.id).chat.lastMessagePreview, '[Imagen] diagrama.svg');

    // 1) Delete a single attachment (imgAtt from msg1)
    const updatedMsg1 = store.deleteAttachment(chat.id, msg1.id, imgAtt.id);
    const deletedImgEntry = updatedMsg1.attachments.find((a) => a.id === imgAtt.id);
    const intactPdfEntry = updatedMsg1.attachments.find((a) => a.id === pdfAtt.id);

    assert.equal(deletedImgEntry.deleted, true);
    assert.equal(deletedImgEntry.size, 0);
    assert.equal(intactPdfEntry.deleted, false);
    assert.equal(intactPdfEntry.size, pdfBytes.length);
    assert.equal(fs.existsSync(imgInfo.filePath), false, 'Physical image file must be removed');
    assert.equal(fs.existsSync(pdfInfo.filePath), true, 'Other attachment file must remain');
    assert.throws(
      () => store.getAttachmentInfo(imgAtt.id),
      (err) => err.statusCode === 404
    );

    // 2) Delete a message (msg2 containing svgAtt)
    const svgInfo = store.getAttachmentInfo(svgAtt.id);
    assert.equal(fs.existsSync(svgInfo.filePath), true);

    const delMsgRes = store.deleteMessage(chat.id, msg2.id);
    assert.deepEqual(delMsgRes, { ok: true });
    assert.equal(fs.existsSync(svgInfo.filePath), false, 'Physical file of deleted message must be removed');
    assert.throws(
      () => store.getAttachmentInfo(svgAtt.id),
      (err) => err.statusCode === 404
    );
    const afterMsgDel = store.getChat(chat.id);
    assert.equal(afterMsgDel.messages.length, 1);
    assert.equal(afterMsgDel.chat.lastMessagePreview, 'Aquí van la captura y el PDF');

    // 3) Delete entire chat -> remaining physical files (pdfAtt + extra file) cleaned up
    const extraAtt = store.saveAttachment({
      fileName: 'extra.txt',
      buffer: Buffer.from('contenido extra', 'utf8')
    });
    const extraInfo = store.getAttachmentInfo(extraAtt.id);
    store.addMessage({
      chatId: chat.id,
      senderNode: 'LOCAL',
      text: 'Último archivo',
      attachments: [extraAtt]
    });

    assert.equal(fs.existsSync(pdfInfo.filePath), true);
    assert.equal(fs.existsSync(extraInfo.filePath), true);

    store.deleteChat(chat.id);

    assert.equal(fs.existsSync(pdfInfo.filePath), false, 'PDF file must be cleaned up when chat is deleted');
    assert.equal(fs.existsSync(extraInfo.filePath), false, 'Extra file must be cleaned up when chat is deleted');
    assert.equal(fs.readdirSync(path.join(dir, 'chat-attachments')).length, 0);
    assert.throws(
      () => store.getChat(chat.id),
      (err) => err.statusCode === 404
    );
    assert.throws(
      () => store.getAttachmentInfo(pdfAtt.id),
      (err) => err.statusCode === 404
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ChatStore: unread counter tracking across multiple chats and markRead', () => {
  const dir = makeTempDir();
  try {
    const store = new ChatStore(dir);
    const c1 = store.createChat({ title: 'Chat Uno' });
    const c2 = store.createChat({ title: 'Chat Dos' });

    assert.equal(store.getTotalUnread(), 0);

    // Outgoing message does NOT increment unread
    store.addMessage({ chatId: c1.id, senderNode: 'ME', text: 'Hola', incoming: false });
    assert.equal(store.getTotalUnread(), 0);

    // Incoming messages increment unread
    store.addMessage({ chatId: c1.id, senderNode: 'PEER1', text: 'Uno', incoming: true });
    store.addMessage({ chatId: c1.id, senderNode: 'PEER1', text: 'Dos', incoming: true });
    store.addMessage({ chatId: c2.id, senderNode: 'PEER2', text: 'Tres', incoming: true });

    assert.equal(store.getChat(c1.id).chat.unreadCount, 2);
    assert.equal(store.getChat(c2.id).chat.unreadCount, 1);
    assert.equal(store.getTotalUnread(), 3);

    // markRead resets only that chat
    store.markRead(c1.id);
    assert.equal(store.getChat(c1.id).chat.unreadCount, 0);
    assert.equal(store.getChat(c2.id).chat.unreadCount, 1);
    assert.equal(store.getTotalUnread(), 1);

    // Reload from disk preserves unread state
    const reloaded = new ChatStore(dir);
    assert.equal(reloaded.getTotalUnread(), 1);
    assert.equal(reloaded.getChat(c1.id).chat.unreadCount, 0);
    assert.equal(reloaded.getChat(c2.id).chat.unreadCount, 1);

    reloaded.markRead(c2.id);
    assert.equal(reloaded.getTotalUnread(), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
