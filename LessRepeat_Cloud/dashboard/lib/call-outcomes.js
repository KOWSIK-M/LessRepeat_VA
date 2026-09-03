'use strict';

// Normalize written digits only; do not infer missing digits or translate names.
const DIGIT_STARTS = [0x0660,0x06f0,0x0966,0x09e6,0x0a66,0x0ae6,0x0b66,0x0be6,0x0c66,0x0ce6,0x0d66,0xff10];
function normalizePhoneDigits(value) {
  return String(value).replace(/\p{Decimal_Number}/gu, character => {
    const code=character.codePointAt(0),start=DIGIT_STARTS.find(start=>code>=start&&code<=start+9);
    return start===undefined?character:String(code-start);
  });
}
function collectOutcome(schema, context = {}) {
  const extracted=context.extracted_variables&&typeof context.extracted_variables==='object'?context.extracted_variables:{};
  return Object.fromEntries(schema.map(field=>{
    let value=context[field.key]!==undefined?context[field.key]:extracted[field.key];
    if(value!==undefined&&value!==null&&value!==''&&/phone|mobile|callback_number|contact_number/i.test(field.key))value=normalizePhoneDigits(value);
    return [field.key,value];
  }).filter(([,value])=>value!==undefined&&value!==null&&value!==''));
}
module.exports={collectOutcome,normalizePhoneDigits};
