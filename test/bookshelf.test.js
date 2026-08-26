const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const tempBooks = fs.mkdtempSync(path.join(os.tmpdir(), 'retell-trainer-books-'));
process.env.BOOKS_DIR = tempBooks;
const shelf = require('../bookshelf');

function epubBuffer() {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from(
    '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'
  ));
  zip.addFile('OEBPS/content.opf', Buffer.from(
    '<?xml version="1.0"?><package><metadata><title>测试图书</title></metadata><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>'
  ));
  zip.addFile('OEBPS/chapter.xhtml', Buffer.from('<html><body><h1>第一章</h1><p>测试正文。</p></body></html>'));
  return zip.toBuffer();
}

test.after(() => fs.rmSync(tempBooks, { recursive: true, force: true }));

test('imports a valid EPUB and exposes it through the bookshelf scan', () => {
  const result = shelf.importEpub(epubBuffer(), '文件夹/测试图书.epub');
  assert.equal(result.added, true);
  assert.equal(result.book.title, '测试图书');
  assert.equal(shelf.scanBooks().length, 1);
});

test('skips an identical EPUB and rejects invalid content', () => {
  const duplicate = shelf.importEpub(epubBuffer(), '测试图书.epub');
  assert.equal(duplicate.added, false);
  assert.throws(() => shelf.importEpub(Buffer.from('not a zip'), '坏书.epub'), /不是有效的 EPUB/);
  assert.throws(() => shelf.importEpub(epubBuffer(), '测试图书.pdf'), /只支持上传 EPUB/);
});
