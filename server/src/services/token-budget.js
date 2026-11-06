import { getEncoding } from 'js-tiktoken';

const encodings = new Map();
const supported = new Set(['cl100k_base', 'o200k_base']);

export function resolveTokenizer(model) {
  const requested = model?.tokenizer || 'auto';
  if (requested === 'none') return null;
  if (supported.has(requested)) return requested;
  if (requested !== 'auto') return null;

  const modelId = String(model?.upstreamModelId || model?.id || '').toLowerCase();
  if (/^(gpt-5|gpt-4\.5|gpt-4\.1|gpt-4o|o1(?:-|$)|o3(?:-|$)|o4-mini(?:-|$))/.test(modelId)) {
    return 'o200k_base';
  }
  if (/^(gpt-4(?:-|$)|gpt-3\.5-turbo|gpt-35-turbo)/.test(modelId)) {
    return 'cl100k_base';
  }
  return null;
}

function getCachedEncoding(name) {
  if (!encodings.has(name)) encodings.set(name, getEncoding(name));
  return encodings.get(name);
}

function safeByteCount(messages) {
  return messages.reduce((total, message) => (
    total
    + Buffer.byteLength(String(message.role || ''), 'utf8')
    + Buffer.byteLength(String(message.content || ''), 'utf8')
    + 4
  ), 2);
}

export function countPromptTokens(messages, model, options = {}) {
  const tokenizer = resolveTokenizer(model);
  if (tokenizer) {
    try {
      const encoding = getCachedEncoding(tokenizer);
      const tokens = messages.reduce((total, message) => (
        total
        + encoding.encode(String(message.role || '')).length
        + encoding.encode(String(message.content || '')).length
        + 4
      ), 2);
      return {
        tokens,
        tokenizer,
        source: 'tokenizer_estimate',
        confidence: 'estimate',
        warning: null,
      };
    } catch {
      if (!options.allowByteUpperBound) {
        return { tokens: null, tokenizer: null, source: 'unknown', confidence: 'unknown', warning: 'TOKENIZER_UNAVAILABLE' };
      }
      return {
        tokens: safeByteCount(messages),
        tokenizer: 'utf8-byte-upper-bound',
        source: 'byte_upper_bound',
        confidence: 'conservative',
        warning: 'TOKENIZER_UNAVAILABLE',
      };
    }
  }

  if (options.allowByteUpperBound) {
    return {
      tokens: safeByteCount(messages),
      tokenizer: 'utf8-byte-upper-bound',
      source: 'byte_upper_bound',
      confidence: 'conservative',
      warning: null,
    };
  }

  return {
    tokens: null,
    tokenizer: null,
    source: 'unknown',
    confidence: 'unknown',
    warning: null,
  };
}

export function estimateMessageTokens(message, model, options = {}) {
  return countPromptTokens([message], model, options).tokens;
}
