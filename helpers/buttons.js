alse };
  }
  const interactive = content.interactiveMessage;
  if (!interactive) {
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
      try { JSON.parse(btn.buttonParamsJson); } catch (e) { warnings.push(`buttons[${i}] buttonParamsJson invalid JSON (${e.message})`); }
    }
    if (!btn.name) {
      warnings.push(`buttons[${i}] missing name; defaulting to quick_reply`);
      btn.name = 'quick_reply';
    }
  });
  return { errors, warnings, valid: errors.length === 0 };
}

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
  } else {
    return { tag: 'biz', attrs: {} };
  }
}

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
      interactiveMessage.header = { title: content.title || content.subtitle || '' };
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

/* ---------- core send functions (fixed for ESM dynamic import) ---------- */

export async function sendInteractiveMessage(sock, jid, content, options = {}) {
  if (!sock) {
    throw new InteractiveValidationError('Socket is required', { context: 'sendInteractiveMessage' });
  }

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

  const convertedContent = convertToInteractiveMessage(content);

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

  // ESM dynamic import loop
  const candidatePkgs = ['baileys', '@whiskeysockets/baileys', '@adiwajshing/baileys'];
  let generateWAMessageFromContent, normalizeMessageContent, isJidGroup, generateMessageIDV2;
  let relayMessage;
  let loaded = false;

  for (const pkg of candidatePkgs) {
    if (loaded) break;
    try {
      // dynamic import (works in ESM)
      const ns = await import(pkg);
      const mod = ns.default || ns;
      generateWAMessageFromContent = mod.generateWAMessageFromContent || mod.Utils?.generateWAMessageFromContent;
      normalizeMessageContent = mod.normalizeMessageContent || mod.Utils?.normalizeMessageContent;
      isJidGroup = mod.isJidGroup || mod.WABinary?.isJidGroup;
      generateMessageIDV2 = mod.generateMessageIDV2 || mod.Utils?.generateMessageIDV2 || mod.generateMessageID || mod.Utils?.generateMessageID;
      relayMessage = sock.relayMessage;
      if (generateWAMessageFromContent && normalizeMessageContent && isJidGroup && relayMessage) {
        loaded = true;
      }
    } catch (e) {
      // ignore and try next
    }
  }

  if (!loaded) {
    throw new InteractiveValidationError('Missing baileys internals', {
      context: 'sendInteractiveMessage.dynamicImport',
      errors: ['generateWAMessageFromContent or normalizeMessageContent not found in installed packages: baileys / @whiskeysockets/baileys / @adiwajshing/baileys'],
      example: { install: 'npm i baileys', importUsage: "import { generateWAMessageFromContent } from 'baileys'" }
    });
  }

  const userJid = sock.authState?.creds?.me?.id || sock.user?.id;
  const messageIdArg = (typeof generateMessageIDV2 === 'function') ? generateMessageIDV2(userJid) : undefined;
  const fullMsg = generateWAMessageFromContent(jid, convertedContent, {
    logger: sock.logger,
    userJid,
    messageId: messageIdArg,
    timestamp: new Date(),
    ...options
  });

  const normalizedContent = normalizeMessageContent(fullMsg.message);
  const buttonType = getButtonType(normalizedContent);
  let additionalNodes = [...(options.additionalNodes || [])];
  if (buttonType) {
    const buttonsNode = getButtonArgs(normalizedContent);
    const isPrivate = !isJidGroup(jid);
    additionalNodes.push(buttonsNode);
    if (isPrivate) additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
    console.log('Interactive send: ', {
      type: buttonType,
      nodes: additionalNodes.map(n => ({ tag: n.tag, attrs: n.attrs })),
      private: !isJidGroup(jid)
    });
  }

  await relayMessage(jid, fullMsg.message, {
    messageId: fullMsg.key.id,
    useCachedGroupMetadata: options.useCachedGroupMetadata,
    additionalAttributes: options.additionalAttributes || {},
    statusJidList: options.statusJidList,
    additionalNodes
  });

  const isPrivateChat = !isJidGroup(jid);
  if (sock.config?.emitOwnEvents && isPrivateChat) {
    process.nextTick(() => {
      if (sock.processingMutex?.mutex && sock.upsertMessage) {
        sock.processingMutex.mutex(() => sock.upsertMessage(fullMsg, 'append'));
      }
    });
  }

  return fullMsg;
}

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

/* ---------- default export (CJS compatibility object) ---------- */

export {
  sendButtons: sendInteractiveButtonsBasic,
  sendInteractiveMessage,
  getButtonType,
  getButtonArgs,
  InteractiveValidationError,
  validateAuthoringButtons,
  validateInteractiveMessageContent,
  validateSendButtonsPayload,
  validateSendInteractiveMessagePayload,
  buildInteractiveButtons,
  parseButtonParams,
  validateSendInteractiveMessagePayload
};
