import AVFoundation
import Foundation
import Speech

// On-device speech-to-text. Usage:
//   transcribe <audio-file> <out.txt> <out.srt> [locale] [progress-file]
// Progress lines "PROGRESS <percent>" go to stdout and, if given, the progress
// file. The file route exists because TCC only honors our Info.plist when we're
// launched through LaunchServices (`open`), which detaches stdout.

func emit(_ s: String, _ progressFile: String?) {
    print(s)
    FileHandle.standardOutput.synchronizeFile()
    if let pf = progressFile { try? s.appendLine(to: URL(fileURLWithPath: pf)) }
}

extension String {
    func appendLine(to url: URL) throws {
        if let h = FileHandle(forWritingAtPath: url.path) { defer { try? h.close() }; h.seekToEndOfFile(); h.write(self.data(using: .utf8)!) }
        else { try self.data(using: .utf8)!.write(to: url) }
    }
}

func srtTime(_ t: TimeInterval) -> String {
    let ms = Int((t.truncatingRemainder(dividingBy: 1)) * 1000)
    let s = Int(t) % 60, m = (Int(t) / 60) % 60, h = Int(t) / 3600
    return String(format: "%02d:%02d:%02d,%03d", h, m, s, ms)
}

let args = CommandLine.arguments
guard args.count >= 4 else {
    FileHandle.standardError.write("usage: transcribe <audio> <out.txt> <out.srt> [locale] [progress-file]\n".data(using: .utf8)!)
    exit(2)
}
let input = args[1], txtPath = args[2], srtPath = args[3]
let localeID = args.count > 4 ? args[4] : "en-US"
let progressFile: String? = args.count > 5 ? args[5] : nil

func finish(_ code: Int32, _ msg: String? = nil) -> Never {
    if let m = msg {
        FileHandle.standardError.write((m + "\n").data(using: .utf8)!)
        emit("ERROR \(m)", progressFile)
    }
    exit(code)   // exits from any thread/callback, no flag juggling
}

let locale = Locale(identifier: localeID)
guard let recognizer = SFSpeechRecognizer(locale: locale) else { finish(3, "no recognizer for \(localeID)") }

SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else { finish(4, "speech recognition not authorized (\(status.rawValue))") }
    let rec = recognizer
    if !rec.supportsOnDeviceRecognition { finish(5, "on-device recognition unavailable for \(localeID)") }

    let url = URL(fileURLWithPath: input)
    let request = SFSpeechURLRecognitionRequest(url: url)
    request.shouldReportPartialResults = true   // partials give us progress
    request.requiresOnDeviceRecognition = true
    request.addsPunctuation = true
    request.taskHint = .dictation

    var segments: [(TimeInterval, TimeInterval, String)] = []
    var fullText = ""

    rec.recognitionTask(with: request) { result, error in
        if let r = result {
            fullText = r.bestTranscription.formattedString
            segments = r.bestTranscription.segments.map { ($0.timestamp, $0.timestamp + $0.duration, $0.substring) }
            if let dur = try? AVAudioPlayer(contentsOf: url).duration, dur > 0 {
                let last = segments.last?.1 ?? 0
                emit("PROGRESS \(min(99, Int(last / dur * 100)))", progressFile)
            }
            if r.isFinal {
                // merge fragments into readable caption lines (~9 words each)
                var lines: [(TimeInterval, TimeInterval, String)] = []
                for (start, end, text) in segments {
                    if let last = lines.last, last.2.split(separator: " ").count < 9 {
                        lines[lines.count - 1].1 = end
                        lines[lines.count - 1].2 += " " + text
                    } else { lines.append((start, end, text)) }
                }
                try? fullText.write(toFile: txtPath, atomically: true, encoding: .utf8)
                var srt = ""
                for (i, l) in lines.enumerated() {
                    srt += "\(i + 1)\n\(srtTime(l.0)) --> \(srtTime(l.1))\n\(l.2.trimmingCharacters(in: .whitespaces))\n\n"
                }
                try? srt.write(toFile: srtPath, atomically: true, encoding: .utf8)
                emit("PROGRESS 100", progressFile)
                emit("WORDS \(fullText.split(separator: " ").count)", progressFile)
                finish(0)
            }
        }
        if let e = error as NSError?, e.code != 216 {
            finish(6, "recognition error \(e.code): \(e.localizedDescription)")
        } else if error != nil {
            finish(7, "task canceled")
        }
    }
}

// keep the runloop alive: Speech delivers callbacks through it.
// finish() exits the process; a watchdog kills us if nothing comes back in 30 min.
Timer.scheduledTimer(withTimeInterval: 1800, repeats: false) { _ in finish(8, "timed out") }
while true {
    RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.25))
}
