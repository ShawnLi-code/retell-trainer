const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const trainer = require('../interview-trainer');

test('loads both interview question collections', () => {
  const questions = trainer.allQuestions();
  assert.equal(questions.length, 2580);
  assert.equal(questions.filter((item) => item.type === 'real').length, 2346);
  assert.equal(questions.filter((item) => item.type === 'interview').length, 234);
});

test('hides answers from public question cards and keeps them for a started session', async () => {
  const question = trainer.random('interview');
  assert.ok(question);
  const publicCard = trainer.publicQuestion(question);
  assert.equal(Object.hasOwn(publicCard, 'standardAnswer'), false);
  const recordsFile = path.join(__dirname, '..', 'data', 'interview-records.json');
  const before = fs.existsSync(recordsFile) ? JSON.parse(fs.readFileSync(recordsFile, 'utf8')) : [];
  let started;
  try {
    started = await trainer.start(question.id);
    assert.equal(started.status, 'answering');
    assert.equal(started.question.standardAnswer, question.standardAnswer);
  } finally {
    const after = fs.existsSync(recordsFile) ? JSON.parse(fs.readFileSync(recordsFile, 'utf8')) : [];
    const ids = new Set(before.map((record) => record.id));
    const kept = after.filter((record) => ids.has(record.id));
    if (kept.length) fs.writeFileSync(recordsFile, JSON.stringify(kept, null, 2));
    else if (fs.existsSync(recordsFile)) fs.unlinkSync(recordsFile);
  }
});
