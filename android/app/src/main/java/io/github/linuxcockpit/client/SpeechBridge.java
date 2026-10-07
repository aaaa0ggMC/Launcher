package io.github.linuxcockpit.client;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.Locale;
import java.util.Set;

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
 * 所有系统对象都在主线程上创建和调用。朗读 = 合成 wav 后自己播放（0.8.1，见 TTS 一节）。
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
    //
    // 0.8.1：仿 RikkaHub——先 synthesizeToFile 合成 wav，再由本 App 的 MediaPlayer 播放。
    // 不少厂商引擎对第三方 App 的 speak() 不出声 / 不回调，合成到文件这条路最稳；合成失败才退回 speak()。
    // 引擎绑定失败 / 初始化回调迟迟不来（8 秒）都会明确报错，下次调用重新初始化，而不是永远卡住。

    private static final long INIT_TIMEOUT_MS = 8000;
    private final Handler main = new Handler(Looper.getMainLooper());
    private Runnable initTimeout;
    private String ttsError = "";

    /** 当前朗读：id / 合成中的文件 / 播放器 */
    private String curId;
    private File curFile;
    private MediaPlayer player;

    /** 在主线程上调用：TTS 就绪后执行 r（失败时 r 也会执行，由调用方看 ttsState） */
    private void withTts(Runnable r) {
        if (tts == null) {
            ttsState = -1;
            final TextToSpeech[] self = new TextToSpeech[1];
            self[0] = new TextToSpeech(act, status -> act.runOnUiThread(() -> {
                if (tts != self[0] || ttsState != -1) return;
                if (status == TextToSpeech.SUCCESS) {
                    ttsState = 0;
                    tts.setOnUtteranceProgressListener(progress);
                } else failInit("system tts init failed (" + status + ")");
                flushWaiting();
            }));
            tts = self[0];
            initTimeout = () -> {
                if (tts == self[0] && ttsState == -1) {
                    failInit("system tts engine did not respond");
                    flushWaiting();
                }
            };
            main.postDelayed(initTimeout, INIT_TIMEOUT_MS);
        }
        if (ttsState == -1) ttsWaiting.add(r);
        else r.run();
    }

    private void failInit(String why) {
        ttsState = 1;
        ttsError = why;
        try {
            if (tts != null) tts.shutdown();
        } catch (Exception ignored) {
        }
        // 先跑完等待中的（它们看到 ttsState=1 报错），下次调用再重新初始化
        main.post(() -> {
            if (ttsState == 1) tts = null;
        });
    }

    private void flushWaiting() {
        if (initTimeout != null) main.removeCallbacks(initTimeout);
        initTimeout = null;
        ArrayList<Runnable> run = new ArrayList<>(ttsWaiting);
        ttsWaiting.clear();
        for (Runnable x : run) x.run();
    }

    private String unavailable() {
        return "system tts unavailable" + (ttsError.isEmpty() ? "" : ": " + ttsError);
    }

    private final UtteranceProgressListener progress = new UtteranceProgressListener() {
        @Override
        public void onStart(String id) {
            // 合成到文件时 onStart 是「开始合成」，真正出声由 MediaPlayer 发 start
            act.runOnUiThread(() -> {
                if (id != null && id.equals(curId) && curFile == null) ttsEvent(id, "start", null);
            });
        }

        @Override
        public void onDone(String id) {
            act.runOnUiThread(() -> {
                if (id == null || !id.equals(curId)) return;
                if (curFile != null) play(id, curFile);
                else {
                    curId = null;
                    ttsEvent(id, "done", null);
                }
            });
        }

        @Override
        @Deprecated
        public void onError(String id) {
            onError(id, -1);
        }

        @Override
        public void onError(String id, int code) {
            act.runOnUiThread(() -> {
                if (id == null || !id.equals(curId)) return;
                dropFile();
                curId = null;
                ttsEvent(id, "error", "tts error " + code);
            });
        }

        @Override
        public void onStop(String id, boolean interrupted) {
        }

        @Override
        public void onRangeStart(String id, int start, int end, int frame) {
            // 只有 speak() 直接出声时才有意义（合成到文件时它跟着合成走，不是跟着播放走）
            if (curFile != null) return;
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

    private void play(String id, File file) {
        releasePlayer();
        try {
            MediaPlayer mp = new MediaPlayer();
            mp.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
            mp.setDataSource(file.getAbsolutePath());
            mp.setOnCompletionListener(m -> {
                if (!id.equals(curId)) return;
                curId = null;
                releasePlayer();
                dropFile();
                ttsEvent(id, "done", null);
            });
            mp.setOnErrorListener((m, what, extra) -> {
                if (id.equals(curId)) {
                    curId = null;
                    releasePlayer();
                    dropFile();
                    ttsEvent(id, "error", "playback error " + what + "/" + extra);
                }
                return true;
            });
            mp.prepare();
            player = mp;
            mp.start();
            ttsEvent(id, "start", null);
        } catch (Exception e) {
            curId = null;
            releasePlayer();
            dropFile();
            ttsEvent(id, "error", "playback failed: " + e.getMessage());
        }
    }

    private void releasePlayer() {
        if (player != null) {
            try {
                player.release();
            } catch (Exception ignored) {
            }
            player = null;
        }
    }

    private void dropFile() {
        if (curFile != null) {
            //noinspection ResultOfMethodCallIgnored
            curFile.delete();
            curFile = null;
        }
    }

    /** 打断当前朗读（合成中 / 播放中都算） */
    private void interrupt() {
        curId = null;
        releasePlayer();
        dropFile();
        if (tts != null && ttsState == 0) tts.stop();
    }

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
                reply.fail(unavailable());
                return;
            }
            try {
                JSONArray list = new JSONArray();
                Set<Voice> vs = null;
                try {
                    vs = tts.getVoices();
                } catch (Exception ignored) {
                    // 个别引擎 getVoices() 直接抛异常
                }
                if (vs != null) {
                    for (Voice v : vs) {
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
                reply.fail(unavailable());
                return;
            }
            try {
                interrupt();
                String voice = args.optString("voice", "");
                boolean voiceSet = false;
                if (!voice.isEmpty()) {
                    try {
                        Set<Voice> vs = tts.getVoices();
                        if (vs != null) {
                            for (Voice v : vs) {
                                if (v.getName().equals(voice)) {
                                    voiceSet = tts.setVoice(v) == TextToSpeech.SUCCESS;
                                    break;
                                }
                            }
                        }
                    } catch (Exception ignored) {
                    }
                }
                if (!voiceSet) {
                    String lang = args.optString("lang", "");
                    int lr = lang.isEmpty() ? TextToSpeech.LANG_NOT_SUPPORTED
                            : tts.setLanguage(Locale.forLanguageTag(lang));
                    // 引擎不支持这个语言：退回系统默认语言（RikkaHub 也是这么用的）
                    if (lr < TextToSpeech.LANG_AVAILABLE) tts.setLanguage(Locale.getDefault());
                }
                tts.setSpeechRate((float) args.optDouble("rate", 1.0));
                tts.setPitch((float) args.optDouble("pitch", 1.0));
                int max = TextToSpeech.getMaxSpeechInputLength();
                String t = text.length() > max ? text.substring(0, max) : text;

                curId = id;
                File dir = new File(act.getCacheDir(), "tts");
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
                curFile = new File(dir, id.replaceAll("[^A-Za-z0-9_-]", "_") + ".wav");
                int r = tts.synthesizeToFile(t, null, curFile, id);
                if (r != TextToSpeech.SUCCESS) {
                    // 合成到文件不支持：退回引擎直接出声
                    dropFile();
                    r = tts.speak(t, TextToSpeech.QUEUE_FLUSH, null, id);
                }
                if (r == TextToSpeech.SUCCESS) {
                    JSONObject o = new JSONObject();
                    o.put("id", id);
                    reply.ok(o);
                } else {
                    curId = null;
                    reply.fail("tts speak failed");
                }
            } catch (Exception e) {
                curId = null;
                dropFile();
                reply.fail(String.valueOf(e.getMessage()));
            }
        }));
    }

    void stopTts() {
        act.runOnUiThread(this::interrupt);
    }

    // ------------------------------------------------------------ ASR

    void startAsr(JSONObject args, Reply reply) {
        act.runOnUiThread(() -> {
            if (!SpeechRecognizer.isRecognitionAvailable(act)) {
                reply.fail("system speech recognition unavailable");
                return;
            }
            // 已授权也在本进程第一次用时申请一次（见 MainActivity.micAsked）
            if (!act.micAsked
                    || act.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
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

    /** 系统默认语音识别服务的包名（设置里的「语音输入」），拿不到为空串 */
    private String recognizerHint() {
        try {
            String v = Settings.Secure.getString(act.getContentResolver(), "voice_recognition_service");
            if (v == null || v.isEmpty()) return "";
            int slash = v.indexOf('/');
            return " (" + (slash > 0 ? v.substring(0, slash) : v) + ")";
        } catch (Exception e) {
            return "";
        }
    }

    private String errorText(int code) {
        switch (code) {
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "no-speech";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                // 本 App 的录音权限在 startAsr 里已经确认过：这里多半是识别服务（小爱 / Google 等）自己没有麦克风权限
                return "recognizer permission denied" + recognizerHint();
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
        interrupt();
        if (tts != null) {
            tts.shutdown();
            tts = null;
        }
        destroyRecognizer();
    }
}
