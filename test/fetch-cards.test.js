const test = require('node:test');
const assert = require('node:assert/strict');
const { extractItems, getFeedHealth, sanitizeCardText, normalizePublishedDate, publishedDateFromHtml } = require('../fetch_cards');

test('parses RSS CDATA, article link and publish date', () => {
  const items = extractItems(`<?xml version="1.0"?>
    <rss><channel><item>
      <title><![CDATA[一篇 &amp; 测试]]></title>
      <link>https://example.com/posts/1</link>
      <pubDate>Wed, 26 Aug 2026 08:00:00 GMT</pubDate>
      <description><![CDATA[<p>这是一段用于测试的完整摘要内容。</p>]]></description>
    </item></channel></rss>`);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '一篇 & 测试');
  assert.equal(items[0].link, 'https://example.com/posts/1');
  assert.equal(items[0].content, '这是一段用于测试的完整摘要内容。');
  assert.equal(items[0].publishedAt, 'Wed, 26 Aug 2026 08:00:00 GMT');
});

test('normalizes feed and page publication dates', () => {
  assert.equal(normalizePublishedDate('Wed, 26 Aug 2026 08:00:00 GMT'), '2026-08-26');
  assert.equal(publishedDateFromHtml('<meta property="article:published_time" content="2026-08-25T18:28:34-04:00">'), '2026-08-25');
  assert.equal(publishedDateFromHtml('', 'https://example.com/2026/08/20/story'), '2026-08-20');
});

test('preserves feed paragraphs and removes urls and common page noise', () => {
  const items = extractItems(`<rss><channel><item><title>Test</title><description><![CDATA[
    <p>第一段完整内容，用于练习复述。</p><p>第二段完整内容，结构清晰。</p>
  ]]></description></item></channel></rss>`);
  assert.equal(items[0].content, '第一段完整内容，用于练习复述。\n\n第二段完整内容，结构清晰。');
  assert.equal(sanitizeCardText('正文请访问 https://example.com/x\n\nRead full article\n\n正文请访问'), '正文请访问');
});

test('parses Atom alternate link and exposes configured feed health', () => {
  const items = extractItems(`<feed><entry>
    <title>Atom 示例</title>
    <link rel="self" href="https://example.com/feed.xml" />
    <link rel="alternate" href="https://example.com/atom/1" />
    <updated>2026-08-26T08:00:00Z</updated>
    <content type="html"><![CDATA[<p>Atom 正文内容</p>]]></content>
  </entry></feed>`);
  assert.equal(items[0].link, 'https://example.com/atom/1');
  assert.equal(items[0].content, 'Atom 正文内容');
  assert.ok(getFeedHealth().some((feed) => feed.name === '美团技术团队'));
  assert.equal(getFeedHealth().find((feed) => feed.name === 'BBC World').status, 'disabled');
});
