package io.github.linuxcockpit.client;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Locale;

/**
 * 系统语音（0.8.0）：WebView 没有 speechSynthesis / SpeechRecognition，这里把系统的
 * TextToSpeech 与 SpeechRecognizer 经原生桥交给页面（渲染端 SDK 见 src/main/ui/speech.ts）。
 *
 * <ul>
 *   <li>{@code tts.voices} → {@code {voices:[{id,name,lang,local}], engine}}</li>
 *   <li>{@code tts.speak {id,text,lang?,voice?,rate?,pitch?}}：打断正在说的；进度是事件
 *       {@code tts {id,type:start|done|error|range,start?,end?,error?}}</li>
 *   <li>{@code tts.stop}</li>
 *   <li>{@code asr.start {lang?,partial?}}：要录音权限（没有就先申请）；事件
 *       {@code asr {type:ready|partial|final|level|error|end,text?,error?,level?}}</li>
 *   <li>{@code asr.stop}（说完了，等最终结果）/ {@code asr.cancel}（丢弃）</li>
 * </ul>
 * 所有系统对象都在主线程上创建和调用。
 */
final class SpeechBridge {
    static final int REQ_ASR = 6;

    private final MainActivity act;
    private TextToSpeech tts;
    /** -1 = 初始化中，0 = 可用，其余 = 失败 */
    private int ttsState = -1;
    private final ArrayList<Runnable> ttsWaiting = new ArrayList<>();

    private SpeechRecognizer recognizer;
    /** 等录音权限时暂存的 asr.start 参数 */
    private JSONObject pendingAsr;

    SpeechBridge(MainActivity act) {
        this.act = act;
    }

    static boolean asrAvailable(MainActivity act) {
        return SpeechRecognizer.isRecognitionAvailable(act);
    }

    // ------------------------------------------------------------ TTS

    /** 在主线程上调用：TTS 就绪后执行 r（失败时 r 也会执行，由调用方看 ttsState） */
    private void withTts(Runnable r) {
        if (tts == null) {
            ttsState = -1;
            tts = new TextToSpeech(act, status -> {
                ttsState = status == TextToSpeech.SUCCESS ? 0 : 1;
                if (ttsState == 0) tts.setOnUtteranceProgressListener(progress);
                ArrayList<Runnable> run = new ArrayList<>(ttsWaiting);
                ttsWaiting.clear();
                for (Runnable x : run) x.run();
            });
        }
        if (ttsState == -1) ttsWaiting.add(r);
        else r.run();
    }

    private final UtteranceProgressListener progress = new UtteranceProgressListener() {
        @Override
        public void onStart(String id) {
            ttsEvent(id, "start", null);
        }

        @Override
        public void onDone(String id) {
            ttsEvent(id, "done", null);
        }

        @Override
        @Deprecated
        public void onError(String id) {
            ttsEvent(id, "error", "tts error");
        }

        @Override
        public void onError(String id, int code) {
            ttsEvent(id, "error", "tts error " + code);
        }

        @Override
        public void onStop(String id, boolean interrupted) {
            ttsEvent(id, "stopped", null);
        }

        @Override
        public void onRangeStart(String id, int start, int end, int frame) {
            try {
                JSONObject o = new JSONObject();
                o.put("id", id);
                o.put("type", "range");
                o.put("start", start);
                o.put("end", end);
                act.emit("tts", o);
            } catch (Exception ignored) {
            }
        }
    };

    private void ttsEvent(String id, String type, String error) {
        try {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("type", type);
            if (error != null) o.put("error", error);
            act.emit("tts", o);
        } catch (Exception ignored) {
        }
    }

    interface Reply {
        void ok(JSONObject data);

        void fail(String error);
    }

    void voices(Reply reply) {
        act.runOnUiThread(() -> withTts(() -> {
            if (ttsState != 0) {
                reply.fail("system tts unavailable");
                return;
            }
            try {
                JSONArray list = new JSONArray();
                if (tts.getVoices() != null) {
                    for (Voice v : tts.getVoices()) {
                        JSONObject o = new JSONObject();
                        o.put("id", v.getName());
                        o.put("name", v.getName());
                        o.put("lang", v.getLocale().toLanguageTag());
                        o.put("local", !v.isNetworkConnectionRequired());
                        list.put(o);
                    }
                }
                JSONObject o = new JSONObject();
                o.put("voices", list);
                o.put("engine", tts.getDefaultEngine());
                reply.ok(o);
            } catch (Exception e) {
                reply.fail(String.valueOf(e.getMessage()));
            }
        }));
    }

    void speak(JSONObject args, Reply reply) {
        final String id = args.optString("id", "u" + System.nanoTime());
        final String text = args.optString("text", "");
        act.runOnUiThread(() -> withTts(() -> {
            if (ttsState != 0) {
                reply.fail("system tts unavailable");
                return;
            }
            try {
                String voice = args.optString("voice", "");
                boolean voiceSet = false;
                if (!voice.isEmpty() && tts.getVoices() != null) {
                    for (Voice v : tts.getVoices()) {
                        if (v.getName().equals(voice)) {
                            tts.setVoice(v);
                            voiceSet = true;
                            break;
                        }
                    }
                }
                String lang = args.optString("lang", "");
                if (!voiceSet && !lang.isEmpty()) tts.setLanguage(Locale.forLanguageTag(lang));
                tts.setSpeechRate((float) args.optDouble("rate", 1.0));
                tts.setPitch((float) args.optDouble("pitch", 1.0));
                int max = TextToSpeech.getMaxSpeechInputLength();
                String t = text.length() > max ? text.substring(0, max) : text;
                int r = tts.speak(t, TextToSpeech.QUEUE_FLUSH, null, id);
                if (r == TextToSpeech.SUCCESS) {
                    JSONObject o = new JSONObject();
                    o.put("id", id);
                    reply.ok(o);
                } else reply.fail("tts speak failed");
            } catch (Exception e) {
                reply.fail(String.valueOf(e.getMessage()));
            }
        }));
    }

    void stopTts() {
        act.runOnUiThread(() -> {
            if (tts != null && ttsState == 0) tts.stop();
        });
    }

    // ------------------------------------------------------------ ASR

    void startAsr(JSONObject args, Reply reply) {
        act.runOnUiThread(() -> {
            if (!SpeechRecognizer.isRecognitionAvailable(act)) {
                reply.fail("system speech recognition unavailable");
                return;
            }
            if (act.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                pendingAsr = args;
                act.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_ASR);
                // 结果经事件回来（授权后开始 / 拒绝后 error），这里先应答「已受理」
                reply.ok(new JSONObject());
                return;
            }
            begin(args);
            reply.ok(new JSONObject());
        });
    }

    /** MainActivity.onRequestPermissionsResult 转过来 */
    void onPermission(boolean granted) {
        JSONObject args = pendingAsr;
        pendingAsr = null;
        if (args == null) return;
        if (granted) begin(args);
        else {
            asrEvent("error", null, "permission denied");
            asrEvent("end", null, null);
        }
    }

    private void begin(JSONObject args) {
        if (recognizer != null) recognizer.destroy();
        recognizer = SpeechRecognizer.createSpeechRecognizer(act);
        recognizer.setRecognitionListener(listener);
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, args.optBoolean("partial", true));
        String lang = args.optString("lang", "");
        if (!lang.isEmpty()) intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        recognizer.startListening(intent);
    }

    void stopAsr() {
        act.runOnUiThread(() -> {
            if (recognizer != null) recognizer.stopListening();
        });
    }

    void cancelAsr() {
        act.runOnUiThread(() -> {
            pendingAsr = null;
            if (recognizer != null) {
                recognizer.cancel();
                recognizer.destroy();
                recognizer = null;
            }
        });
    }

    private void asrEvent(String type, String text, String error) {
        try {
            JSONObject o = new JSONObject();
            o.put("type", type);
            if (text != null) o.put("text", text);
            if (error != null) o.put("error", error);
            act.emit("asr", o);
        } catch (Exception ignored) {
        }
    }

    private static String first(Bundle b) {
        ArrayList<String> r = b == null ? null : b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return r == null || r.isEmpty() ? "" : r.get(0);
    }

    private final RecognitionListener listener = new RecognitionListener() {
        private long lastLevel;

        @Override
        public void onReadyForSpeech(Bundle params) {
            asrEvent("ready", null, null);
        }

        @Override
        public void onBeginningOfSpeech() {
        }

        @Override
        public void onRmsChanged(float rmsdB) {
            // 电平事件限流（约 15 次 / 秒），-2..10 dB 映射到 0..1
            long now = System.currentTimeMillis();
            if (now - lastLevel < 66) return;
            lastLevel = now;
            try {
                JSONObject o = new JSONObject();
                o.put("type", "level");
                o.put("level", Math.max(0, Math.min(1, (rmsdB + 2) / 12.0)));
                act.emit("asr", o);
            } catch (Exception ignored) {
            }
        }

        @Override
        public void onBufferReceived(byte[] buffer) {
        }

        @Override
        public void onEndOfSpeech() {
        }

        @Override
        public void onError(int error) {
            asrEvent("error", null, errorText(error));
            asrEvent("end", null, null);
            destroyRecognizer();
        }

        @Override
        public void onResults(Bundle results) {
            asrEvent("final", first(results), null);
            asrEvent("end", null, null);
            destroyRecognizer();
        }

        @Override
        public void onPartialResults(Bundle partial) {
            String t = first(partial);
            if (!t.isEmpty()) asrEvent("partial", t, null);
        }

        @Override
        public void onEvent(int eventType, Bundle params) {
        }
    };

    private void destroyRecognizer() {
        if (recognizer != null) {
            recognizer.destroy();
            recognizer = null;
        }
    }

    private static String errorText(int code) {
        switch (code) {
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "no-speech";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "permission denied";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "network";
            case SpeechRecognizer.ERROR_AUDIO:
                return "audio";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "busy";
            default:
                return "error " + code;
        }
    }

    void release() {
        if (tts != null) {
            tts.shutdown();
            tts = null;
        }
        destroyRecognizer();
    }
}
