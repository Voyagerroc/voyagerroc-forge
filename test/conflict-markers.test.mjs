import test from 'node:test';
import assert from 'node:assert/strict';
import { contentChecks } from '../src/edit-worker.mjs';

const conflicts = content => contentChecks('notes.txt', content).find(check => check.name === 'conflicts:notes.txt');

for (const newline of ['\n', '\r\n']) {
  for (const marker of ['||||||| base', '|||||||', '<<<<<<<<< ours', '=========', '>>>>>>>>> theirs']) {
    test(`unresolved ${JSON.stringify(marker)} is rejected with ${JSON.stringify(newline)} line endings`, () => {
      const result = conflicts(['before', marker, 'after'].join(newline));
      assert.equal(result.status, 'failed');
      assert.equal(result.detail, 'Unresolved conflict marker');
    });
  }
}

test('short, inline and non-marker runs remain ordinary text', () => {
  for (const text of ['======', 'a ||||||| base', '|||||||value', '>>>>>>>value', 'a ======= b']) {
    assert.equal(conflicts(text).status, 'passed', text);
  }
});
