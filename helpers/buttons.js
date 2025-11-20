// interactive-buttons.js
import baileys, {
  generateMessageIDV2,
  isJidGroup,
  normalizeMessageContent,
  generateWAMessageFromContent
} from "baileys";

/**
 * Utilities
 */
function safeJsonParse(str) {
  try {
    return { value: JSON.parse(str), error: null };
  } catch (e) {
    return { value: null, error: e };
  }
}

function safeJsonStringify(val) {
  try {
    return { value: JSON.stringify(val), error: null };
  } catch (e) {
    return { value: null, error: e };
  }
}

/**
 * Build interactive button objects in the canonical authoring shape.
 * Accepts a mix of legacy and new shapes and returns normalized objects.
 */
export function buildInteractiveButtons(buttons = []) {
  return buttons.map((b, i) => {
    if (!b || typeof b !== 'object') return b;

    // Already normalized
    if (b.name && b.buttonParamsJson) return b;

    // Legacy quick reply shape { id, text } or { id, displayText }
    if (b.id || b.text || b.displayText) {
      const display_text = b.text ?? b.displayText ?? `Button ${i + 1}`;
      const id = b.id ?? `quick_${i + 1}`;
      return {
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({ display_text, id })
      };
    }

    // Baileys-like button shape { buttonId, buttonText: { displayText } }
    if (b.buttonId && b.buttonText?.displayText) {
      return {
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({
          display_text: b.buttonText.displayText,
          id: b.buttonId
        })
      };
    }

    // Fallback: return original
    return b;
  });
}

/**
 * Validate a set of authoring buttons and return errors/warnings + cleaned clones.
 * Does NOT mutate the original array (works on clones).
 */
export function validateAuthoringButtons(buttons) {
  const errors = [];
  const warnings = [];

  if (buttons == null) {
    return { errors: [], warnings: [], valid: true, cleaned: [] };
  }
  if (!Array.isArray(buttons)) {
    errors.push('buttons must be an array');
    return { errors, warnings, valid: false, cleaned: [] };
  }

  const SOFT_BUTTON_CAP = 25;
  if (buttons.length === 0) {
    warnings.push('buttons array is empty');
  } else if (buttons.length > SOFT_BUTTON_CAP) {
    warnings.push(`buttons count (${buttons.length}) exceeds soft cap of ${SOFT_BUTTON_CAP}; may be rejected by client`);
  }

  const cleaned = buttons.map((orig, idx) => {
    if (orig == null || typeof orig !== 'object') {
      errors.push(`button[${idx}] is not an object`);
      return orig;
    }

    // clone to avoid mutating original
    const b = { ...orig };

    if (b.name && b.buttonParamsJson) {
      if (typeof b.buttonParamsJson !== 'string') {
        errors.push(`button[${idx}] buttonParamsJson must be string`);
      } else {
        const { error } = safeJsonParse(b.buttonParamsJson);
        if (error) errors.push(`button[${idx}] buttonParamsJson is not valid JSON: ${error.message}`);
      }
      return b;
    }

    // Accept simple legacy shapes
    if (b.id || b.text || b.displayText) {
      return b;
    }

    // Accept message-style buttonText/buttonId
    if (b.buttonId && b.buttonText && typeof b.buttonText === 'object' && b.buttonText.displayText) {
      return b;
    }

    // If someone passed a parsed object in buttonParamsJson, try to stringify
    if (b.buttonParamsJson) {
      if (typeof b.buttonParamsJson !== 'string') {
        warnings.push(`button[${idx}] has non-string buttonParamsJson; will attempt to stringify`);
        const { value, error } = safeJsonStringify(b.buttonParamsJson);
        if (error) {
          errors.push(`button[${idx}] buttonParamsJson could not be serialized: ${error.message}`);
          return b;
        }
        b.buttonParamsJson = value;
      } else {
        const { error } = safeJsonParse(b.buttonParamsJson);
        if (error) warnings.push(`button[${idx}] buttonParamsJson not valid JSON (${error.message})`);
      }
      if (!b.name) {
        warnings.push(`button[${idx}] missing name; defaulting to quick_reply`);
        b.name = 'quick_reply';
      }
      return b;
    }

    warnings.push(`button[${idx}] unrecognized shape; passing through unchanged`);
    return b;
  });

  return { errors, warnings, valid: errors.length === 0, cleaned };
}

/**
 * Custom error class for interactive validation problems.
 */
export class InteractiveValidationError extends Error {
  constructor(message, { context, errors = [], warnings = [], example } = {}) {
    super(message);
    this.name = 'InteractiveValidationError';
    this.context = context;
    this.errors = errors;
    this.warnings = warnings;
    this.example = example;
  }
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      context: this.context,
      errors: this.errors,
      warnings: this.warnings,
      example: this.example
    };
  }
  formatDetailed() {
    const lines = [
      `[${this.name}] ${this.message}${this.context ? ' (' + this.context + ')' : ''}`
    ];
    if (this.errors?.length) {
      lines.push('Errors:');
      this.errors.forEach(e => lines.push('  - ' + e));
    }
    if (this.warnings?.length) {
      lines.push('Warnings:');
      this.warnings.forEach(w => lines.push('  - ' + w));
    }
    if (this.example) {
      lines.push('Example payload:', JSON.stringify(this.example, null, 2));
    }
    return lines.join('\n');
  }
}

/**
 * Example payloads used in error messages
 */
const EXAMPLE_PAYLOADS = {
  sendButtons: {
    text: 'Choose an option',
    buttons: [
      { id: 'opt1', text: 'Option 1' },
      { id: 'opt2', text: 'Option 2' },
      { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: 'Visit Site', url: 'https://example.com' }) }
    ],
    footer: 'Footer text'
  },
  sendInteractiveMessage: {
    text: 'Pick an action',
    interactiveButtons: [
      { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Hello', id: 'hello' }) },
      { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: 'Copy Code', copy_code: 'ABC123' }) }
    ],
    footer: 'Footer'
  }
};

/**
 * Allowed / required maps
 */
const SEND_BUTTONS_ALLOWED_COMPLEX = new Set(['cta_url', 'cta_copy', 'cta_call']);
const INTERACTIVE_ALLOWED_NAMES = new Set([
  'quick_reply', 'cta_url', 'cta_copy', 'cta_call', 'cta_catalog', 'cta_reminder', 'cta_cancel_reminder',
  'address_message', 'send_location', 'open_webview', 'mpm', 'wa_payment_transaction_details',
  'automated_greeting_message_view_catalog', 'galaxy_message', 'single_select'
]);

const REQUIRED_FIELDS_MAP = {
  cta_url: ['display_text', 'url'],
  cta_copy: ['display_text', 'copy_code'],
  cta_call: ['display_text', 'phone_number'],
  cta_catalog: ['business_phone_number'],
  cta_reminder: ['display_text'],
  cta_cancel_reminder: ['display_text'],
  address_message: ['display_text'],
  send_location: ['display_text'],
  open_webview: ['title', 'link'],
  mpm: ['product_id'],
  wa_payment_transaction_details: ['transaction_id'],
  automated_greeting_message_view_catalog: ['business_phone_number', 'catalog_product_id'],
  galaxy_message: ['flow_token', 'flow_id'],
  single_select: ['title', 'sections'],
  quick_reply: ['display_text', 'id']
};

/**
 * Parse buttonParamsJson and validate required fields for named types.
 */
export function parseButtonParams(name, buttonParamsJson, errors, warnings, index) {
  const { value: parsed, error } = safeJsonParse(buttonParamsJson);
  if (error) {
    errors.push(`button[${index}] (${name}) invalid JSON: ${error.message}`);
    return null;
  }

  const req = REQUIRED_FIELDS_MAP[name] || [];
  for (const f of req) {
    if (!(f in parsed)) {
      errors.push(`button[${index}] (${name}) missing required field '${f}'`);
    }
  }

  if (name === 'open_webview' && parsed.link) {
    if (typeof parsed.link !== 'object' || !parsed.link.url) {
      errors.push(`button[${index}] (open_webview) link.url required`);
    }
  }

  if (name === 'single_select') {
    if (!Array.isArray(parsed.sections) || parsed.sections.length === 0) {
      errors.push(`button[${index}] (single_select) sections must be non-empty array`);
    }
  }

  return parsed;
}

/**
 * Validation for "sendButtons" style payloads (legacy quick reply + limited complex CTAs).
 */
export function validateSendButtonsPayload(data) {
  const errors = [];
  const warnings = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['payload must be an object'], warnings };
  }
  if (!data.text || typeof data.text !== 'string') {
    errors.push('text is mandatory and must be a string');
  }
  if (!Array.isArray(data.buttons) || data.buttons.length === 0) {
    errors.push('buttons is mandatory and must be a non-empty array');
  } else {
    data.buttons.forEach((btn, i) => {
      if (!btn || typeof btn !== 'object') {
        errors.push(`button[${i}] must be an object`);
        return;
      }
      // legacy quick reply shape
      if (btn.id && btn.text) {
        if (typeof btn.id !== 'string' || typeof btn.text !== 'string') {
          errors.push(`button[${i}] legacy quick reply id/text must be strings`);
        }
        return;
      }
      // complex named shapes allowed in sendButtons
      if (btn.name && btn.buttonParamsJson) {
        if (!SEND_BUTTONS_ALLOWED_COMPLEX.has(btn.name)) {
          errors.push(`button[${i}] name '${btn.name}' not allowed in sendButtons`);
          return;
        }
        if (typeof btn.buttonParamsJson !== 'string') {
          errors.push(`button[${i}] buttonParamsJson must be string`);
          return;
        }
        parseButtonParams(btn.name, btn.buttonParamsJson, errors, warnings, i);
        return;
      }
      errors.push(`button[${i}] invalid shape (must be legacy quick reply or named ${Array.from(SEND_BUTTONS_ALLOWED_COMPLEX).join(', ')})`);
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validation for "interactive" authoring payloads.
 */
export function validateSendInteractiveMessagePayload(data) {
  const errors = [];
  const warnings = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['payload must be an object'], warnings };
  }
  if (!data.text || typeof data.text !== 'string') {
    errors.push('text is mandatory and must be a string');
  }
  if (!Array.isArray(data.interactiveButtons) || data.interactiveButtons.length === 0) {
    errors.push('interactiveButtons is mandatory and must be a non-empty array');
  } else {
    data.interactiveButtons.forEach((btn, i) => {
      if (!btn || typeof btn !== 'object') {
        errors.push(`interactiveButtons[${i}] must be an object`);
        return;
      }
      if (!btn.name || typeof btn.name !== 'string') {
        errors.push(`interactiveButtons[${i}] missing name`);
        return;
      }
      if (!INTERACTIVE_ALLOWED_NAMES.has(btn.name)) {
        errors.push(`interactiveButtons[${i}] name '${btn.name}' not allowed`);
        return;
      }
      if (!btn.buttonParamsJson || typeof btn.buttonParamsJson !== 'string') {
        errors.push(`interactiveButtons[${i}] buttonParamsJson must be string`);
        return;
      }
      parseButtonParams(btn.name, btn.buttonParamsJson, errors, warnings, i);
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate the final content object that will be passed to generateWAMessageFromContent
 */
export function validateInteractiveMessageContent(content) {
  const errors = [];
  const warnings = [];

  if (!content || typeof content !== 'object') {
    return { errors: ['content must be an object'], warnings, valid: false };
  }

  const interactive = content.interactiveMessage;
  if (!interactive) {
    // nothing interactive to validate — caller may be using other message types
    return { errors, warnings, valid: true };
  }

  const nativeFlow = interactive.nativeFlowMessage;
  if (!nativeFlow) {
    errors.push('interactiveMessage.nativeFlowMessage missing');
    return { errors, warnings, valid: false };
  }

  if (!Array.isArray(nativeFlow.buttons)) {
    errors.push('nativeFlowMessage.buttons must be an array');
    return { errors, warnings, valid: false };
  }
  if (nativeFlow.buttons.length === 0) {
    warnings.push('nativeFlowMessage.buttons is empty');
  }

  nativeFlow.buttons.forEach((btn, i) => {
    if (!btn || typeof btn !== 'object') {
      errors.push(`buttons[${i}] is not an object`);
      return;
    }
    if (!btn.buttonParamsJson) {
      warnings.push(`buttons[${i}] missing buttonParamsJson (may fail to render)`);
    } else if (typeof btn.buttonParamsJson !== 'string') {
      errors.push(`buttons[${i}] buttonParamsJson must be string`);
    } else {
      const { error } = safeJsonParse(btn.buttonParamsJson);
      if (error) warnings.push(`buttons[${i}] buttonParamsJson invalid JSON (${error.message})`);
    }
    if (!btn.name) {
      warnings.push(`buttons[${i}] missing name; defaulting to quick_reply`);
      btn.name = 'quick_reply';
    }
  });

  return { errors, warnings, valid: errors.length === 0 };
}

/**
 * Helpers to determine button type and args for nodes
 */
export function getButtonType(message) {
  if (message.listMessage) return 'list';
  if (message.buttonsMessage) return 'buttons';
  if (message.interactiveMessage?.nativeFlowMessage) return 'native_flow';
  return null;
}

export function getButtonArgs(message) {
  const nativeFlow = message.interactiveMessage?.nativeFlowMessage;
  const firstButtonName = nativeFlow?.buttons?.[0]?.name;
  const nativeFlowSpecials = [
    'mpm', 'cta_catalog', 'send_location',
    'call_permission_request', 'wa_payment_transaction_details',
    'automated_greeting_message_view_catalog'
  ];

  if (nativeFlow && (firstButtonName === 'review_and_pay' || firstButtonName === 'payment_info')) {
    return {
      tag: 'biz',
      attrs: {
        native_flow_name: firstButtonName === 'review_and_pay' ? 'order_details' : firstButtonName
      }
    };
  } else if (nativeFlow && nativeFlowSpecials.includes(firstButtonName)) {
    return {
      tag: 'biz',
      attrs: {},
      content: [{
        tag: 'interactive',
        attrs: { type: 'native_flow', v: '1' },
        content: [{ tag: 'native_flow', attrs: { v: '2', name: firstButtonName } }]
      }]
    };
  } else if (nativeFlow || message.buttonsMessage) {
    return {
      tag: 'biz',
      attrs: {},
      content: [{
        tag: 'interactive',
        attrs: { type: 'native_flow', v: '1' },
        content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
      }]
    };
  } else if (message.listMessage) {
    return {
      tag: 'biz',
      attrs: {},
      content: [{ tag: 'list', attrs: { v: '2', type: 'product_list' } }]
    };
  }
  return { tag: 'biz', attrs: {} };
}

/**
 * Convert a user-friendly "interactiveButtons" authoring shape into the
 * structure expected by generateWAMessageFromContent (nativeFlowMessage).
 * Returns a new object (does not mutate input).
 */
export function convertToInteractiveMessage(content) {
  if (content.interactiveButtons && content.interactiveButtons.length > 0) {
    const interactiveMessage = {
      nativeFlowMessage: {
        buttons: content.interactiveButtons.map(btn => ({
          name: btn.name || 'quick_reply',
          buttonParamsJson: btn.buttonParamsJson
        }))
      }
    };

    if (content.title || content.subtitle) {
      interactiveMessage.header = { title: content.title ?? content.subtitle ?? '' };
    }
    if (content.text) interactiveMessage.body = { text: content.text };
    if (content.footer) interactiveMessage.footer = { text: content.footer };

    const newContent = { ...content };
    delete newContent.interactiveButtons;
    delete newContent.title;
    delete newContent.subtitle;
    delete newContent.text;
    delete newContent.footer;

    return { ...newContent, interactiveMessage };
  }
  return content;
}

/**
 * Main: send an interactive message using a baileys socket-like object.
 */
export async function sendInteractiveMessage(sock, jid, content, options = {}) {
  if (!sock) {
    throw new InteractiveValidationError('Socket is required', { context: 'sendInteractiveMessage' });
  }

  // If the caller provided interactiveButtons in authoring shape, validate that authoring payload
  if (content && Array.isArray(content.interactiveButtons)) {
    const strict = validateSendInteractiveMessagePayload(content);
    if (!strict.valid) {
      throw new InteractiveValidationError('Interactive authoring payload invalid', {
        context: 'sendInteractiveMessage.validateSendInteractiveMessagePayload',
        errors: strict.errors,
        warnings: strict.warnings,
        example: EXAMPLE_PAYLOADS.sendInteractiveMessage
      });
    }
    if (strict.warnings.length) console.warn('sendInteractiveMessage warnings:', strict.warnings);
  }

  // Convert authoring shape to nativeFlowMessage shape
  const convertedContent = convertToInteractiveMessage(content);

  // Validate converted content
  const { errors: contentErrors, warnings: contentWarnings, valid: contentValid } = validateInteractiveMessageContent(convertedContent);
  if (!contentValid) {
    throw new InteractiveValidationError('Converted interactive content invalid', {
      context: 'sendInteractiveMessage.validateInteractiveMessageContent',
      errors: contentErrors,
      warnings: contentWarnings,
      example: convertToInteractiveMessage(EXAMPLE_PAYLOADS.sendInteractiveMessage)
    });
  }
  if (contentWarnings.length) {
    console.warn('Interactive content warnings:', contentWarnings);
  }

  // get relay function safely
  const relayMessage = sock?.relayMessage;
  if (typeof relayMessage !== 'function') {
    throw new InteractiveValidationError('Socket does not expose relayMessage function', { context: 'sendInteractiveMessage' });
  }

  // prepare userJid & messageId
  const userJid = sock.authState?.creds?.me?.id || sock.user?.id;
  const messageIdArg = (typeof generateMessageIDV2 === 'function' && userJid) ? generateMessageIDV2(userJid) : undefined;

  // create full message
  const fullMsg = generateWAMessageFromContent(jid, convertedContent, {
    logger: sock.logger,
    userJid,
    messageId: messageIdArg,
    timestamp: Date.now(),
    ...options
  });

  const normalizedContent = normalizeMessageContent(fullMsg.message);
  const buttonType = getButtonType(normalizedContent);

  const additionalNodes = [...(options.additionalNodes || [])];
  if (buttonType) {
    const buttonsNode = getButtonArgs(normalizedContent);
    const isPrivate = !isJidGroup(jid);
    additionalNodes.push(buttonsNode);
    if (isPrivate) additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
    console.log('Interactive send: ', {
      type: buttonType,
      nodes: additionalNodes.map(n => ({ tag: n.tag, attrs: n.attrs })),
      private: isPrivate
    });
  }

  await relayMessage(jid, fullMsg.message, {
    messageId: fullMsg.key?.id,
    useCachedGroupMetadata: options.useCachedGroupMetadata,
    additionalAttributes: options.additionalAttributes || {},
    statusJidList: options.statusJidList,
    additionalNodes
  });

  // If socket wants to emit own events, upsert the message into local store
  const isPrivateChat = !isJidGroup(jid);
  if (sock.config?.emitOwnEvents && isPrivateChat) {
    process.nextTick(() => {
      try {
        if (sock.processingMutex?.mutex && typeof sock.upsertMessage === 'function') {
          // assume mutex takes a callback to run exclusively; if different API, adapt accordingly
          sock.processingMutex.mutex(() => sock.upsertMessage(fullMsg, 'append'));
        }
      } catch (e) {
        // don't break the send flow for local upsert failures
        console.warn('upsertMessage failed:', e?.message ?? e);
      }
    });
  }

  return fullMsg;
}

/**
 * Convenience wrapper for the legacy sendButtons authoring shape.
 */
export async function sendInteractiveButtonsBasic(sock, jid, data = {}, options = {}) {
  if (!sock) {
    throw new InteractiveValidationError('Socket is required', { context: 'sendButtons' });
  }

  const { text = '', footer = '', title, subtitle, buttons = [] } = data;
  const strict = validateSendButtonsPayload({ text, buttons, title, subtitle, footer });
  if (!strict.valid) {
    throw new InteractiveValidationError('Buttons payload invalid', {
      context: 'sendButtons.validateSendButtonsPayload',
      errors: strict.errors,
      warnings: strict.warnings,
      example: EXAMPLE_PAYLOADS.sendButtons
    });
  }
  if (strict.warnings.length) console.warn('sendButtons warnings:', strict.warnings);

  const { errors, warnings, cleaned } = validateAuthoringButtons(buttons);
  if (errors.length) {
    throw new InteractiveValidationError('Authoring button objects invalid', {
      context: 'sendButtons.validateAuthoringButtons',
      errors,
      warnings,
      example: EXAMPLE_PAYLOADS.sendButtons.buttons
    });
  }
  if (warnings.length) {
    console.warn('Button validation warnings:', warnings);
  }

  const interactiveButtons = buildInteractiveButtons(cleaned);

  const payload = { text, footer, interactiveButtons };
  if (title) payload.title = title;
  if (subtitle) payload.subtitle = subtitle;

  return sendInteractiveMessage(sock, jid, payload, options);
}

export const sendButtons = sendInteractiveButtonsBasic;
