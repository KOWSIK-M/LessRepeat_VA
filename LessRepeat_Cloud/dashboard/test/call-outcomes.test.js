'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {collectOutcome,normalizePhoneDigits}=require('../lib/call-outcomes');

test('mixed-language captured details retain names, schema keys, false and zero',()=>{
  const schema=['caller_name','callback_number','reason','callback_consent','guest_count','unknown'].map(key=>({key}));
  const record=collectOutcome(schema,{extracted_variables:{caller_name:'కౌశిక్',callback_number:'+९१ ०१२३४५६७८९',reason:'NEET గురించి जानकारी కావాలి',callback_consent:false,guest_count:0,extra:'not in business schema'}});
  assert.deepEqual(record,{caller_name:'కౌశిక్',callback_number:'+91 0123456789',reason:'NEET గురించి जानकारी కావాలి',callback_consent:false,guest_count:0});
  assert.deepEqual(JSON.parse(JSON.stringify(record)),record);
});

test('phone normalization preserves country code, leading zeros, separators and unknown digits',()=>{
  assert.equal(normalizePhoneDigits('+౯౧ ౦౧౨౩౪౫౬౭౮౯'),'+91 0123456789');
  assert.equal(normalizePhoneDigits('০১২-৩৪?'),'012-34?');
  assert.equal(normalizePhoneDigits('۰۰۱۲۳'),'00123');
});

test('flat run fields and nested extracted fields are both supported without inventing missing values',()=>{
  assert.deepEqual(collectOutcome([{key:'caller_name'},{key:'phone'},{key:'missing'}],{caller_name:'रवि',extracted_variables:{phone:'९८७६'}}),{caller_name:'रवि',phone:'9876'});
});
