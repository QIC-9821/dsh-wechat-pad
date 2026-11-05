/**
 * 协议端 webhook 载荷 → 统一的内部消息形态。
 *
 * 各家 iPad 协议端（WeChatPadPro / Gewechat 系）字段名不完全一致，这里做容错：
 * 同一个语义从多个可能的键里取，取不到就给空值，绝不因为缺字段抛异常。
 */

function unbox(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : '';
  if (Array.isArray(value)) return value.map(unbox).filter(Boolean).join('');
  if (typeof value === 'object') {
    for (const key of ['string', 'String', 'value', 'Value', 'text', 'Text', 'str']) {
      if (value[key] !== undefined) return unbox(value[key]);
    }
  }
  return '';
}

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return undefined;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 从 <msgsource><atuserlist><![CDATA[a,b]]></atuserlist>… 里抠出被 @ 的人。 */
export function parseAtList(msgSource) {
  const source = unbox(msgSource);
  if (!source) return [];
  const out = new Set();
  for (const pattern of [/<atuserlist>(?:<!\[CDATA\[)?([^<\]]*)/i, /<atuserlist[^>]*>([^<]*)/i]) {
    const match = source.match(pattern);
    if (!match) continue;
    for (const raw of match[1].split(/[,;\s]+/)) {
      const id = raw.trim();
      if (id) out.add(id);
    }
  }
  return [...out];
}

/** 去掉正文开头的 @某某 前缀。 */
export function stripLeadingMentions(text, names = []) {
  let out = String(text ?? '');
  if (names.length > 0) {
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`^@${escaped}[\\s\\u2005]*`, 'u'), '');
    }
  }
  // 兜底：一条消息开头连续几个 @token（群里 @ 别人也长这样），只削前两个以内的 token
  let guard = 0;
  while (guard < 3) {
    const match = out.match(/^@[^\s@:：]{1,32}[\s\u2005]+/u);
    if (!match) break;
    out = out.slice(match[0].length);
    guard += 1;
  }
  return out.trim();
}

function splitPreview(pushContent) {
  const text = unbox(pushContent);
  if (!text) return null;
  const match = text.match(/^(.{1,32}?)[:：]\s*\n?([\s\S]*)$/u);
  if (!match) return null;
  return { senderName: match[1].trim(), text: match[2].trim() };
}

/**
 * @returns {Array<{msgId:string,groupId:string,groupName:string,senderId:string,senderName:string,
 *   text:string,msgType:number,isGroup:boolean,isSelf:boolean,atList:string[],atMe:boolean,createTime:number,raw:object}>}
 */
export function normalizeWebhook(payload, options = {}) {
  const selfWxid = String(options.selfWxid ?? '').trim();
  const botNames = Array.isArray(options.botNames) ? options.botNames : [];

  const container = payload && typeof payload === 'object' ? payload : {};
  const dataNode = container.data ?? container.Data ?? container.message ?? container.msg ?? container;
  const items = Array.isArray(dataNode) ? dataNode : [dataNode];

  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    const from = unbox(pick(item, ['FromUserName', 'fromUserName', 'from_user_name', 'FromUser', 'from']));
    const to = unbox(pick(item, ['ToUserName', 'toUserName', 'to_user_name', 'ToUser', 'to']));
    const roomFromPayload = unbox(pick(item, ['ChatRoomName', 'chatRoomName', 'RoomName', 'room', 'StrChatRoomUserName']));
    const isGroup = Boolean(roomFromPayload) || from.endsWith('@chatroom') || to.endsWith('@chatroom');

    const groupId = roomFromPayload || (from.endsWith('@chatroom') ? from : to.endsWith('@chatroom') ? to : from);
    const rawContent = unbox(pick(item, ['Content', 'content', 'Text', 'text', 'MsgContent']));
    const pushPreview = splitPreview(pick(item, ['PushContent', 'pushContent']));

    const senderCandidate = unbox(pick(item, [
      'Sender', 'sender', 'ActualSender', 'FromUser', 'SenderUserName', 'StrSender',
      'MemberName', 'SenderId', 'senderId', 'RealSender',
    ]));
    const senderNameCandidate = unbox(pick(item, [
      'SenderName', 'senderName', 'NickName', 'nickName', 'DisplayName', 'FromNickName',
    ])) || pushPreview?.senderName || '';

    const atList = parseAtList(pick(item, ['MsgSource', 'msgSource', 'MsgSourceXml']));
    const atListRaw = pick(item, ['AtWxids', 'atWxids', 'AtList', 'atList', 'AtUsers']);
    if (Array.isArray(atListRaw)) {
      for (const id of atListRaw) {
        const value = unbox(id).trim();
        if (value && !atList.includes(value)) atList.push(value);
      }
    } else if (typeof atListRaw === 'string' && atListRaw.trim()) {
      for (const id of atListRaw.split(',')) {
        const value = id.trim();
        if (value && !atList.includes(value)) atList.push(value);
      }
    }

    let text = rawContent || (isGroup && pushPreview ? pushPreview.text : '') || unbox(pick(item, ['PushContent']));
    const explicitAt = Boolean(pick(item, ['AtMe', 'atMe', 'IsAtMe', 'isAtMe']));
    const atMe = explicitAt
      || (selfWxid !== '' && atList.includes(selfWxid))
      || (botNames.length > 0 && botNames.some((name) => text.includes(`@${name}`)));

    text = stripLeadingMentions(text, botNames);

    const senderId = isGroup
      ? (senderCandidate || (pushPreview && senderNameCandidate ? senderCandidate : '') || '')
      : (senderCandidate || from);

    const isSelf = Boolean(pick(item, ['IsSender', 'isSender', 'IsSelf', 'isSelf', 'Self']) === 1
      || pick(item, ['IsSender', 'isSender', 'IsSelf', 'isSelf']) === true
      || (selfWxid !== '' && from === selfWxid));

    const msgId = unbox(pick(item, ['NewMsgId', 'newMsgId', 'MsgId', 'msgId', 'MsgID', 'MsgSvrId', 'id']));

    const message = {
      msgId: msgId || `${groupId}:${unbox(pick(item, ['CreateTime', 'createTime', 'time']))}:${text.slice(0, 16)}`,
      groupId,
      groupName: unbox(pick(item, ['ChatRoomName', 'RoomName', 'groupName', 'GroupName'])),
      senderId: senderId || (isGroup ? groupId : from),
      senderName: senderNameCandidate,
      text: String(text ?? '').trim(),
      msgType: toNumber(pick(item, ['MsgType', 'msgType', 'Type', 'type'])),
      isGroup,
      isSelf,
      atList,
      atMe,
      createTime: toNumber(pick(item, ['CreateTime', 'createTime', 'Timestamp', 'timestamp'])) || Date.now(),
      raw: item,
    };
    out.push(message);
  }
  return out;
}
