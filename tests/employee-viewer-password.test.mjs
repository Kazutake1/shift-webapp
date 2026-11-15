import test from 'node:test';
import assert from 'node:assert/strict';
import {MIN_VIEWER_PASSWORD_LENGTH,validateViewerPassword,viewerRotationState,viewerRotationMessage} from '../employee-viewer/rotation-policy.mjs';

test('viewer password: 15 chars minimum, no control chars, and independent of employee number',()=>{
 assert.equal(MIN_VIEWER_PASSWORD_LENGTH,15);
 assert.match(validateViewerPassword('short-12345'),/15文字以上/);
 assert.equal(validateViewerPassword('SomeLongPassword!2026'),'');
 assert.match(validateViewerPassword('x'.repeat(129)),/128文字以内/);
 assert.match(validateViewerPassword('valid-long-pass\nword'),/制御文字/);
 assert.match(validateViewerPassword(' '.repeat(15)),/制御文字/);
});

test('viewer password: no secret is written or returned by the reminder policy',()=>{
 const source=JSON.stringify(viewerRotationState({configured:true,lastChangedAt:'2026-11-01T00:00:00+09:00',now:new Date('2026-11-15T03:00:00Z')}));
 assert.equal(source.includes('SomeLongPassword'),false);
 assert.deepEqual(viewerRotationState({configured:false}),{kind:'unconfigured',due:true,elapsedDays:null});
 assert.deepEqual(viewerRotationState({configured:true,lastChangedAt:null}),{kind:'unknown',due:false,elapsedDays:null});
});

test('viewer rotation: first day of new month warns if last rotation is 25 days ago',()=>{
 const r=viewerRotationState({configured:true,lastChangedAt:'2026-10-05T01:00:00+09:00',now:new Date('2026-11-01T03:00:00+09:00')});
 assert.equal(r.kind,'monthly');assert.equal(r.elapsedDays,27);assert.equal(r.due,true);
 assert.match(viewerRotationMessage({configured:true,lastChangedAt:'2026-10-05T01:00:00+09:00'},{now:new Date('2026-11-01T03:00:00+09:00')}),/今月/);
});

test('viewer rotation: changing password the day before month start does not cause a new-day warning',()=>{
 const r=viewerRotationState({configured:true,lastChangedAt:'2026-10-31T21:00:00+09:00',now:new Date('2026-11-01T09:00:00+09:00')});
 assert.deepEqual(r,{kind:'ok',due:false,elapsedDays:1});
});

test('viewer rotation: day 30 warns, day 29 does not; calculations use Tokyo calendar days',()=>{
 const prior='2026-10-15T17:00:00+09:00';
 const before=viewerRotationState({configured:true,lastChangedAt:prior,now:new Date('2026-11-13T10:00:00+09:00')});
 const after=viewerRotationState({configured:true,lastChangedAt:prior,now:new Date('2026-11-14T00:01:00+09:00')});
 assert.equal(before.kind,'monthly');assert.equal(before.elapsedDays,29);
 assert.equal(after.kind,'overdue');assert.equal(after.elapsedDays,30);
 assert.match(viewerRotationMessage({configured:true,lastChangedAt:prior},{now:new Date('2026-11-14T00:01:00+09:00')}),/30日/);
});

test('viewer rotation: invalid and future dates do not incorrectly indicate success',()=>{
 assert.equal(viewerRotationState({configured:true,lastChangedAt:'invalid'}).kind,'unknown');
 assert.equal(viewerRotationState({configured:true,lastChangedAt:'2027-01-01T00:00:00+09:00',now:new Date('2026-11-15T08:00:00+09:00')}).kind,'unknown');
});
