import { MaterialIconButton } from "@/components/buttons/icon-button";
import { useLLM, useSystem } from "@/context";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

// ─── language options ───────────────────────────────────────────────────────

const LANGUAGES = [
  "Chinese (Simplified)",
  "Chinese (Traditional)",
  "English",
  "Japanese",
  "Korean",
  "French",
  "German",
  "Spanish",
  "Portuguese",
  "Russian",
  "Arabic",
  "Italian",
];

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Split text into non-empty paragraphs (blank-line separated). */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Build the per-paragraph translation prompt. */
function buildPrompt(paragraph: string, targetLang: string): string {
  return (
    `Translate the following text into ${targetLang}. ` +
    `Output ONLY the translation, no explanations or extra text.\n\n` +
    `Text to translate:\n${paragraph}`
  );
}

// ─── types ───────────────────────────────────────────────────────────────────

type TranslationState = "idle" | "running" | "paused" | "done" | "error";

interface Segment {
  index: number;
  original: string;
  translated: string;
  streaming: boolean;
}

// ─── LanguageSelector ────────────────────────────────────────────────────────

function LanguageSelector({
  label,
  value,
  onChange,
  colorScheme,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  colorScheme: any;
}) {
  const [open, setOpen] = useState(false);

  const styles = StyleSheet.create({
    wrapper: { gap: 4 },
    labelText: { color: colorScheme.onSurfaceVariant, fontSize: 12 },
    button: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colorScheme.surfaceVariant,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 8,
      gap: 4,
    },
    buttonText: { color: colorScheme.onSurface, flex: 1 },
    arrow: { color: colorScheme.onSurfaceVariant },
    list: {
      backgroundColor: colorScheme.surfaceVariant,
      borderRadius: 8,
      marginTop: 4,
      maxHeight: 200,
    },
    item: {
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: colorScheme.outlineVariant,
    },
    itemText: { color: colorScheme.onSurface },
    selected: { color: colorScheme.primary },
  });

  return (
    <View style={styles.wrapper}>
      <Text style={styles.labelText}>{label}</Text>
      <TouchableOpacity style={styles.button} onPress={() => setOpen((o) => !o)}>
        <Text style={styles.buttonText}>{value}</Text>
        <Text style={styles.arrow}>{open ? "▲" : "▼"}</Text>
      </TouchableOpacity>
      {open && (
        <ScrollView style={styles.list} nestedScrollEnabled>
          {LANGUAGES.map((lang) => (
            <TouchableOpacity
              key={lang}
              style={styles.item}
              onPress={() => {
                onChange(lang);
                setOpen(false);
              }}
            >
              <Text style={[styles.itemText, lang === value && styles.selected]}>
                {lang}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

// ─── SegmentCard ─────────────────────────────────────────────────────────────

function SegmentCard({
  segment,
  colorScheme,
}: {
  segment: Segment;
  colorScheme: any;
}) {
  const styles = StyleSheet.create({
    card: {
      borderRadius: 10,
      backgroundColor: colorScheme.surfaceVariant,
      padding: 12,
      gap: 8,
    },
    indexText: {
      color: colorScheme.outline,
      fontSize: 11,
    },
    original: {
      color: colorScheme.onSurfaceVariant,
      fontSize: 13,
      fontStyle: "italic",
    },
    translated: {
      color: colorScheme.onSurface,
      fontSize: 14,
    },
    streamingDot: {
      color: colorScheme.primary,
    },
  });

  return (
    <View style={styles.card}>
      <Text style={styles.indexText}>§ {segment.index + 1}</Text>
      <Text style={styles.original} numberOfLines={3} ellipsizeMode="tail">
        {segment.original}
      </Text>
      <Text style={styles.translated}>
        {segment.translated}
        {segment.streaming ? <Text style={styles.streamingDot}> ▌</Text> : null}
      </Text>
    </View>
  );
}

// ─── main screen ─────────────────────────────────────────────────────────────

function Translate() {
  const { colorScheme } = useSystem();
  const { ready, busy, prompt, stop } = useLLM();

  // file state
  const [fileName, setFileName] = useState<string | undefined>();
  const [paragraphs, setParagraphs] = useState<string[]>([]);

  // language
  const [targetLang, setTargetLang] = useState<string>("Chinese (Simplified)");

  // translation state
  const [status, setStatus] = useState<TranslationState>("idle");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(0);

  // pause/resume control
  const pausedRef = useRef<boolean>(false);
  const resumeCallbackRef = useRef<(() => void) | null>(null);
  const abortRef = useRef<boolean>(false);

  const scrollRef = useRef<ScrollView>(null);

  // ── pick file ──────────────────────────────────────────────────────────────
  const pickFile = async () => {
    if (status === "running" || status === "paused") return;

    const result = await DocumentPicker.getDocumentAsync({
      type: "text/plain",
      multiple: false,
    });

    if (result.canceled || !result.assets?.length) return;

    const asset = result.assets[0];
    const content = await FileSystem.readAsStringAsync(asset.uri, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    const paras = splitParagraphs(content);

    if (paras.length === 0) {
      Alert.alert("Empty file", "The selected file has no readable text.");
      return;
    }

    setFileName(asset.name);
    setParagraphs(paras);
    setSegments([]);
    setCurrentIndex(0);
    setStatus("idle");
    pausedRef.current = false;
    abortRef.current = false;
  };

  // ── wait while paused ──────────────────────────────────────────────────────
  const waitIfPaused = (): Promise<boolean> =>
    new Promise((resolve) => {
      if (!pausedRef.current) {
        resolve(true);
        return;
      }
      // store callback — resume() will call it
      resumeCallbackRef.current = () => resolve(!abortRef.current);
    });

  // ── translate all ──────────────────────────────────────────────────────────
  const startTranslation = useCallback(
    async (startFrom = 0) => {
      if (!ready) {
        Alert.alert(
          "No model loaded",
          "Please load a local GGUF model first (Settings → Load Model)."
        );
        return;
      }
      if (paragraphs.length === 0) {
        Alert.alert("No file", "Please pick a .txt file first.");
        return;
      }

      setStatus("running");
      pausedRef.current = false;
      abortRef.current = false;

      for (let i = startFrom; i < paragraphs.length; i++) {
        // check abort
        if (abortRef.current) break;

        // wait if user paused
        setStatus("paused");
        const shouldContinue = await waitIfPaused();
        if (!shouldContinue) break;
        setStatus("running");

        setCurrentIndex(i);

        // add streaming placeholder
        setSegments((prev) => {
          const existing = prev.findIndex((s) => s.index === i);
          if (existing !== -1) return prev;
          return [
            ...prev,
            { index: i, original: paragraphs[i], translated: "", streaming: true },
          ];
        });

        // accumulate token stream
        let accumulated = "";

        const messages = [
          {
            id: "sys",
            role: "system" as const,
            content: `You are a professional translator. Translate text accurately and naturally into ${targetLang}. Output ONLY the translation.`,
            metadata: undefined,
          },
          {
            id: `para-${i}`,
            role: "user" as const,
            content: buildPrompt(paragraphs[i], targetLang),
            metadata: undefined,
          },
        ];

        // prompt returns only after the whole completion finishes
        await prompt(messages as any, (token: string) => {
          accumulated += token;
          setSegments((prev) =>
            prev.map((s) =>
              s.index === i
                ? { ...s, translated: accumulated, streaming: true }
                : s
            )
          );
        });

        // mark done streaming
        setSegments((prev) =>
          prev.map((s) =>
            s.index === i ? { ...s, streaming: false } : s
          )
        );

        // auto-scroll
        scrollRef.current?.scrollToEnd({ animated: true });
      }

      if (!abortRef.current) {
        setStatus("done");
      } else {
        setStatus("idle");
      }
    },
    [ready, paragraphs, targetLang, prompt]
  );

  // ── pause ──────────────────────────────────────────────────────────────────
  const handlePause = useCallback(async () => {
    pausedRef.current = true;
    await stop();
    setStatus("paused");
  }, [stop]);

  // ── resume ─────────────────────────────────────────────────────────────────
  const handleResume = useCallback(() => {
    pausedRef.current = false;
    if (resumeCallbackRef.current) {
      const cb = resumeCallbackRef.current;
      resumeCallbackRef.current = null;
      cb();
    } else {
      // resume was called but we hadn't reached waitIfPaused yet — just continue
      setStatus("running");
    }
  }, []);

  // ── stop ───────────────────────────────────────────────────────────────────
  const handleStop = useCallback(async () => {
    abortRef.current = true;
    pausedRef.current = false;
    await stop();
    if (resumeCallbackRef.current) {
      const cb = resumeCallbackRef.current;
      resumeCallbackRef.current = null;
      cb();
    }
    setStatus("idle");
  }, [stop]);

  // ── save result ────────────────────────────────────────────────────────────
  const saveResult = async () => {
    if (segments.length === 0) return;

    const sorted = [...segments].sort((a, b) => a.index - b.index);
    const text = sorted.map((s) => s.translated).join("\n\n");
    const outName = `translated_${fileName ?? "output"}.txt`;
    const outPath = `${FileSystem.documentDirectory}${outName}`;

    await FileSystem.writeAsStringAsync(outPath, text, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(outPath, { mimeType: "text/plain" });
    } else {
      Alert.alert("Saved", `File written to:\n${outPath}`);
    }
  };

  // ── styles ─────────────────────────────────────────────────────────────────
  const styles = StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colorScheme.surface,
    },
    topBar: {
      padding: 16,
      gap: 12,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    fileButton: {
      flex: 1,
      backgroundColor: colorScheme.primaryContainer,
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderRadius: 8,
    },
    fileButtonText: {
      color: colorScheme.onPrimaryContainer,
      fontSize: 13,
    },
    langRow: {
      gap: 12,
    },
    progressRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingBottom: 8,
    },
    progressText: {
      color: colorScheme.onSurface,
      fontSize: 13,
    },
    progressBarBg: {
      height: 4,
      backgroundColor: colorScheme.surfaceVariant,
      marginHorizontal: 16,
      borderRadius: 2,
      marginBottom: 8,
    },
    progressBarFg: {
      height: 4,
      backgroundColor: colorScheme.primary,
      borderRadius: 2,
    },
    controlRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 16,
      paddingVertical: 10,
      paddingHorizontal: 16,
      borderTopWidth: 1,
      borderTopColor: colorScheme.outlineVariant,
    },
    actionButton: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: 10,
      alignItems: "center",
    },
    primaryButton: {
      backgroundColor: colorScheme.primary,
    },
    secondaryButton: {
      backgroundColor: colorScheme.secondaryContainer,
    },
    dangerButton: {
      backgroundColor: colorScheme.errorContainer,
    },
    disabledButton: {
      backgroundColor: colorScheme.surfaceVariant,
      opacity: 0.5,
    },
    buttonText: {
      color: colorScheme.onPrimary,
      fontWeight: "600",
      fontSize: 14,
    },
    secondaryButtonText: {
      color: colorScheme.onSecondaryContainer,
      fontWeight: "600",
      fontSize: 14,
    },
    dangerButtonText: {
      color: colorScheme.onErrorContainer,
      fontWeight: "600",
      fontSize: 14,
    },
    scrollContent: {
      padding: 16,
      gap: 12,
      paddingBottom: 32,
    },
    emptyView: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingBottom: 80,
    },
    emptyText: {
      color: colorScheme.onSurfaceVariant,
      fontSize: 14,
      textAlign: "center",
      paddingHorizontal: 32,
    },
    statusBadge: {
      paddingHorizontal: 10,
      paddingVertical: 2,
      borderRadius: 20,
      backgroundColor: colorScheme.tertiaryContainer ?? colorScheme.secondaryContainer,
    },
    statusText: {
      fontSize: 11,
      color: colorScheme.onTertiaryContainer ?? colorScheme.onSecondaryContainer,
      textTransform: "uppercase",
      letterSpacing: 0.8,
    },
    saveButton: {
      backgroundColor: colorScheme.secondaryContainer,
      paddingVertical: 10,
      paddingHorizontal: 18,
      borderRadius: 20,
    },
    saveText: {
      color: colorScheme.onSecondaryContainer,
      fontWeight: "600",
    },
    notReadyBanner: {
      backgroundColor: colorScheme.errorContainer,
      margin: 16,
      padding: 12,
      borderRadius: 8,
    },
    notReadyText: {
      color: colorScheme.onErrorContainer,
      fontSize: 13,
      textAlign: "center",
    },
  });

  const progress = paragraphs.length > 0 ? currentIndex / paragraphs.length : 0;
  const doneCount = segments.filter((s) => !s.streaming).length;
  const sortedSegments = [...segments].sort((a, b) => a.index - b.index);

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      {/* ── top config area ── */}
      <View style={styles.topBar}>
        {!ready && (
          <View style={styles.notReadyBanner}>
            <Text style={styles.notReadyText}>
              ⚠ No local model loaded. Go to Settings → Load Model to load a GGUF file.
            </Text>
          </View>
        )}

        {/* file picker row */}
        <View style={styles.row}>
          <TouchableOpacity
            style={styles.fileButton}
            onPress={pickFile}
            disabled={status === "running" || status === "paused"}
          >
            <Text style={styles.fileButtonText} numberOfLines={1}>
              {fileName ? `📄 ${fileName}` : "📂 Pick a .txt file…"}
            </Text>
          </TouchableOpacity>

          {segments.length > 0 && status !== "running" && (
            <TouchableOpacity style={styles.saveButton} onPress={saveResult}>
              <Text style={styles.saveText}>Save</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* language selector */}
        <LanguageSelector
          label="Translate to"
          value={targetLang}
          onChange={(v) => {
            if (status === "idle" || status === "done") setTargetLang(v);
          }}
          colorScheme={colorScheme}
        />

        {/* paragraph info */}
        {paragraphs.length > 0 && (
          <Text style={[styles.progressText, { color: colorScheme.onSurfaceVariant }]}>
            {paragraphs.length} paragraph{paragraphs.length !== 1 ? "s" : ""} detected
          </Text>
        )}
      </View>

      {/* ── progress bar ── */}
      {paragraphs.length > 0 && (
        <>
          <View style={styles.progressRow}>
            <Text style={styles.progressText}>
              {doneCount} / {paragraphs.length} translated
            </Text>
            <View style={styles.statusBadge}>
              <Text style={styles.statusText}>
                {status === "running"
                  ? "Translating…"
                  : status === "paused"
                  ? "Paused"
                  : status === "done"
                  ? "Complete"
                  : status === "error"
                  ? "Error"
                  : "Ready"}
              </Text>
            </View>
          </View>
          <View style={styles.progressBarBg}>
            <View
              style={[
                styles.progressBarFg,
                { width: `${Math.round(progress * 100)}%` },
              ]}
            />
          </View>
        </>
      )}

      {/* ── translated segments ── */}
      {sortedSegments.length > 0 ? (
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.scrollContent}
          onContentSizeChange={() => {
            if (status === "running") scrollRef.current?.scrollToEnd({ animated: true });
          }}
        >
          {sortedSegments.map((seg) => (
            <SegmentCard key={seg.index} segment={seg} colorScheme={colorScheme} />
          ))}
          {status === "running" && (
            <ActivityIndicator color={colorScheme.primary} style={{ marginTop: 8 }} />
          )}
        </ScrollView>
      ) : (
        <View style={styles.emptyView}>
          <Text style={{ fontSize: 40 }}>🌐</Text>
          <Text style={styles.emptyText}>
            Pick a .txt file above, choose a target language, then tap Translate.
          </Text>
        </View>
      )}

      {/* ── control buttons ── */}
      <View style={styles.controlRow}>
        {/* START / RESUME */}
        {(status === "idle" || status === "done") && (
          <TouchableOpacity
            style={[
              styles.actionButton,
              styles.primaryButton,
              (!ready || paragraphs.length === 0) && styles.disabledButton,
            ]}
            onPress={() => startTranslation(status === "done" ? 0 : 0)}
            disabled={!ready || paragraphs.length === 0}
          >
            <Text style={styles.buttonText}>
              {status === "done" ? "Re-translate" : "Translate"}
            </Text>
          </TouchableOpacity>
        )}

        {status === "paused" && (
          <>
            <TouchableOpacity
              style={[styles.actionButton, styles.primaryButton]}
              onPress={handleResume}
            >
              <Text style={styles.buttonText}>▶ Resume</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionButton, styles.dangerButton]}
              onPress={handleStop}
            >
              <Text style={styles.dangerButtonText}>■ Stop</Text>
            </TouchableOpacity>
          </>
        )}

        {status === "running" && (
          <>
            <TouchableOpacity
              style={[styles.actionButton, styles.secondaryButton]}
              onPress={handlePause}
            >
              <Text style={styles.secondaryButtonText}>⏸ Pause</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionButton, styles.dangerButton]}
              onPress={handleStop}
            >
              <Text style={styles.dangerButtonText}>■ Stop</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

export default Translate;
