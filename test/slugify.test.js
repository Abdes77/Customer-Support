import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.js';

test('lowercases and hyphenates words', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('removes accents', () => {
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee');
});

test('collapses runs of spaces, punctuation and underscores into one hyphen', () => {
  assert.equal(slugify('a  b__c -- d!'), 'a-b-c-d');
});

test('drops leading and trailing separators', () => {
  assert.equal(slugify('  --Hi--  '), 'hi');
});

test('returns an empty string when there are no letters or digits', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify(' -- !! __ '), '');
});

test('throws a TypeError for a non-string argument', () => {
  assert.throws(() => slugify(42), TypeError);
  assert.throws(() => slugify(undefined), TypeError);
  assert.throws(() => slugify(null), TypeError);
});
