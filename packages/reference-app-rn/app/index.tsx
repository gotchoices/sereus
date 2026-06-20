/**
 * Chat screen — flat list of messages + text input + connection indicator.
 */

import { useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useCadre } from '../src/cadre-context';
import { useChat } from '../src/use-chat';
import { memberDisplayName, type ChatMessage } from '../src/chat-operations';
import { connectionBanner } from '../src/connection-status';
import { TEST_IDS } from '../src/test-ids';

export default function ChatScreen() {
  const cadre = useCadre();
  const activeStrand = cadre.activeStrand;

  const chat = useChat({
    strand: activeStrand,
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

  // Pure derivation (color + text) lives in connection-status.ts so the
  // BackgroundRunner-driven resuming/degraded flags can be unit-tested reaching
  // the bar without rendering this whole screen.
  const banner = connectionBanner({
    resuming: cadre.resuming,
    degraded: cadre.degraded,
    status: cadre.status,
    error: cadre.error,
    strandCount: cadre.strands.size,
    memberCount: chat.members.length,
  });

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      {/* Status bar */}
      <View style={[styles.statusBar, { backgroundColor: banner.color }]} testID={TEST_IDS.chat.statusBar}>
        <Text style={styles.statusText}>{banner.text}</Text>
      </View>

      {/* Strand picker */}
      <StrandPicker
        strandIds={[...cadre.strands.keys()]}
        activeStrandId={activeStrand?.strandId ?? null}
        onSelect={cadre.selectStrand}
      />

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
          editable={cadre.status === 'connected' && !!activeStrand}
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

/**
 * Horizontal row of selectable strand chips plus a label rendering the FULL
 * active strand id. The label's full-id text is what Maestro asserts against to
 * confirm the chat is deterministically showing the working strand.
 */
function StrandPicker({
  strandIds,
  activeStrandId,
  onSelect,
}: {
  strandIds: string[];
  activeStrandId: string | null;
  onSelect: (id: string) => void;
}) {
  if (strandIds.length === 0) return null;

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.pickerRow}
        testID={TEST_IDS.chat.strandPicker}
      >
        {strandIds.map((id) => {
          const active = id === activeStrandId;
          return (
            <Pressable
              key={id}
              testID={TEST_IDS.chat.strandRow(id)}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => onSelect(id)}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {id.slice(0, 8)}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {activeStrandId && (
        // Full id, no numberOfLines clamp so Maestro's exact text match works.
        <Text testID={TEST_IDS.chat.strandLabel} style={styles.strandLabel}>
          {activeStrandId}
        </Text>
      )}
    </View>
  );
}

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
  pickerRow: { flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 6, gap: 6 },
  chip: { backgroundColor: '#2a2a3e', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 5, borderWidth: 1, borderColor: 'transparent' },
  chipActive: { backgroundColor: '#6c63ff', borderColor: '#9c95ff' },
  chipText: { color: '#aaa', fontSize: 12 },
  chipTextActive: { color: '#fff', fontWeight: '600' },
  strandLabel: { color: '#666', fontSize: 9, paddingHorizontal: 12, paddingBottom: 4 },
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

