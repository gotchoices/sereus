/**
 * Chat screen — flat list of messages + text input + connection indicator.
 */

import { useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useCadre } from '../src/cadre-context';
import { useChat } from '../src/use-chat';
import { memberDisplayName, type ChatMessage } from '../src/chat-operations';
import { TEST_IDS } from '../src/test-ids';

export default function ChatScreen() {
  const cadre = useCadre();
  const firstStrand = cadre.strands.values().next().value ?? null;

  const chat = useChat({
    strand: firstStrand,
    memberId: cadre.peerId,
    memberName: cadre.peerId ? memberDisplayName(cadre.peerId) : undefined,
  });

  const [draft, setDraft] = useState('');
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const handleSend = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    try {
      await chat.send(text);
      listRef.current?.scrollToEnd({ animated: true });
    } catch (err) {
      console.warn('Send failed:', err);
      chat.refresh().catch(() => {});
    }
  };

  // ── Connection banner ──────────────────────────────────────────────────

  const statusColor =
    cadre.resuming
      ? '#ff9800'
      : cadre.status === 'connected'
        ? '#4caf50'
        : cadre.status === 'connecting'
          ? '#ff9800'
          : cadre.status === 'error'
            ? '#f44336'
            : '#666';

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      {/* Status bar */}
      <View style={[styles.statusBar, { backgroundColor: statusColor }]} testID={TEST_IDS.chat.statusBar}>
        <Text style={styles.statusText}>
          {cadre.resuming
            ? 'Resuming — syncing…'
            : cadre.status === 'connected'
              ? `Connected · ${cadre.strands.size} strand(s) · ${chat.members.length} member(s)`
              : cadre.status === 'connecting'
                ? 'Connecting…'
                : cadre.error ?? 'Not connected — go to Settings'}
        </Text>
      </View>

      {/* Error banner */}
      {chat.error && (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{chat.error}</Text>
        </View>
      )}

      {/* Message list */}
      <FlatList
        ref={listRef}
        testID={TEST_IDS.chat.messageList}
        data={chat.messages}
        keyExtractor={(m) => String(m.Id)}
        renderItem={({ item }) => (
          <MessageBubble
            msg={item}
            isOwn={item.MemberId === cadre.peerId}
          />
        )}
        contentContainerStyle={styles.list}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
      />

      {/* Composer */}
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          testID={TEST_IDS.chat.messageInput}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message…"
          placeholderTextColor="#666"
          onSubmitEditing={handleSend}
          returnKeyType="send"
          editable={cadre.status === 'connected' && !!firstStrand}
        />
        <Pressable
          style={[styles.sendBtn, !draft.trim() && styles.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!draft.trim()}
          testID={TEST_IDS.chat.sendBtn}
        >
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function MessageBubble({ msg, isOwn }: { msg: ChatMessage; isOwn: boolean }) {
  return (
    <View testID={TEST_IDS.chat.messageRow(msg.Id)} style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleOther]}>
      {!isOwn && (
        <Text style={styles.sender}>{msg.MemberName ?? msg.MemberId.slice(-6)}</Text>
      )}
      <Text style={styles.msgText}>{msg.Content}</Text>
      <Text style={styles.time}>
        {new Date(msg.Timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </Text>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f1a' },
  statusBar: { paddingVertical: 6, paddingHorizontal: 12 },
  statusText: { color: '#fff', fontSize: 12, textAlign: 'center' },
  errorBar: { backgroundColor: '#f44336', paddingVertical: 4, paddingHorizontal: 12 },
  errorText: { color: '#fff', fontSize: 12, textAlign: 'center' },
  list: { padding: 12, paddingBottom: 4 },
  bubble: { maxWidth: '80%', padding: 10, borderRadius: 12, marginBottom: 8 },
  bubbleOwn: { alignSelf: 'flex-end', backgroundColor: '#6c63ff' },
  bubbleOther: { alignSelf: 'flex-start', backgroundColor: '#2a2a3e' },
  sender: { color: '#aaa', fontSize: 11, marginBottom: 2 },
  msgText: { color: '#fff', fontSize: 15 },
  time: { color: 'rgba(255,255,255,0.5)', fontSize: 10, marginTop: 4, textAlign: 'right' },
  composer: { flexDirection: 'row', padding: 8, borderTopWidth: 1, borderTopColor: '#333', backgroundColor: '#1a1a2e' },
  input: { flex: 1, backgroundColor: '#2a2a3e', color: '#fff', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, fontSize: 15 },
  sendBtn: { marginLeft: 8, backgroundColor: '#6c63ff', borderRadius: 20, paddingHorizontal: 16, justifyContent: 'center' },
  sendBtnDisabled: { opacity: 0.4 },
  sendText: { color: '#fff', fontWeight: '600' },
});

