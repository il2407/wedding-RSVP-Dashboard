const DEFAULT_DESIGN = {
  background: '#faf6ef', text_color: '#302e29', font: 'serif', photo_style: 'arch',
  kicker: 'SAVE OUR DATE', title: 'יום אחד. אהבה גדולה.',
  message: 'נשמח לחגוג את היום שלנו יחד איתכם.', signoff: 'with love, always.',
  button_text: 'כן, נגיע לחגוג!', motion: 'on', response_media: 'on',
};
function validateDesign(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid invitation design');
  const result = {};
  const enums = { font: ['serif', 'sans'], photo_style: ['arch', 'polaroid', 'circle', 'natural'], motion: ['on', 'off'], response_media: ['on', 'off'] };
  for (const [key, val] of Object.entries(value)) {
    if (!(Object.hasOwn(DEFAULT_DESIGN, key)) || typeof val !== 'string') throw new Error('Invalid design field');
    if (['background', 'text_color'].includes(key) && !/^#[0-9a-f]{6}$/i.test(val)) throw new Error('Invalid design color');
    if (enums[key] && !enums[key].includes(val)) throw new Error('Invalid design option');
    if (val.length > (key === 'message' ? 600 : 120)) throw new Error('Design text is too long');
    result[key] = val;
  }
  return { ...DEFAULT_DESIGN, ...result };
}
module.exports = { DEFAULT_DESIGN, validateDesign };
