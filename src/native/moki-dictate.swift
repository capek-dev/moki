// moki-dictate: native macOS streaming dictation helper (plan 17 phase B).
// Spawned by Moki's Electron main process on mic-hold. Streams JSON lines on
// stdout; stops on stdin EOF (button released), a final result, or a hard
// 60s cap. Audio is captured with AVAudioEngine and recognized with
// SFSpeechRecognizer (the same engine as the Mac's dictation feature, on
// device when the system model is available, server-assisted otherwise).

import AVFoundation
import Foundation
import Speech

enum Mode { case partial, finalResult, failure }

func emit(_ mode: Mode, text: String) {
  // One JSON object per line; the parent parses with a shared pure parser.
  let event: [String: String]
  switch mode {
  case .partial: event = ["type": "partial", "text": text]
  case .finalResult: event = ["type": "final", "text": text]
  case .failure: event = ["type": "error", "message": text]
  }
  if let data = try? JSONSerialization.data(withJSONObject: event),
     var line = String(data: data, encoding: .utf8) {
    line.append("\n")
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
  }
}

// The speech permission must exist before recognition can start; the
// microphone prompt appears when the input tap starts.
SFSpeechRecognizer.requestAuthorization { status in
  DispatchQueue.main.async {
    switch status {
    case .authorized: startRecognition()
    case .denied, .restricted: emit(.failure, text: "speech-denied"); exit(1)
    default: emit(.failure, text: "unavailable"); exit(1)
    }
  }
}

var stopRequested = false
func stopSession() {
  guard !stopRequested else { return }
  stopRequested = true
  audioEngine.stop()
  audioEngine.inputNode.removeTap(onBus: 0)
  request.endAudio()
  DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) { exit(0) }
}

// Button release arrives as stdin EOF; a background read thread watches for it.
FileHandle.standardInput.readabilityHandler = { handle in
  let chunk = handle.availableData
  if chunk.isEmpty { handle.readabilityHandler = nil; DispatchQueue.main.async { stopSession() } }
}

// A hard cap so a forgotten hold can never wedge the microphone.
DispatchQueue.global().asyncAfter(deadline: .now() + 60) { DispatchQueue.main.async { stopSession() } }

let audioEngine = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
request.contextualStrings = ["Moki"]

func startRecognition() {
  SFSpeechRecognizer.requestAuthorization { _ in } // already authorized; no-op
  let inputNode = audioEngine.inputNode
  let format = inputNode.outputFormat(forBus: 0)
  guard format.channelCount > 0 else { emit(.failure, text: "no-mic"); exit(1) }
  // The tap call is clean at our macOS 13 deployment target; macOS 27 pairs
  // it with a throwing refinement of identical shape that Swift can never
  // select (non-throwing wins), so 27 SDK builds would warn either way.
  inputNode.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
    request.append(buffer)
  }
  audioEngine.prepare()
  do {
    try audioEngine.start()
  } catch {
    // Starting the input usually only fails for permission or missing input.
    emit(.failure, text: "mic-denied"); exit(1)
  }

  guard let recognizer = SFSpeechRecognizer() ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")) else {
    emit(.failure, text: "unavailable"); exit(1)
  }
  var lastEmitted = ""
  recognizer.recognitionTask(with: request) { result, error in
    if stopRequested { return }
    if let result {
      let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
      if !text.isEmpty {
        if result.isFinal {
          emit(.finalResult, text: text)
          DispatchQueue.main.async { stopSession() }
        } else if text != lastEmitted {
          lastEmitted = text
          emit(.partial, text: text)
        }
      }
    }
    if let error {
      // Cancelled by our own stop is normal; anything else surfaces as a
      // no-speech style failure the renderer shows once.
      if (error as NSError).code != 216 /* kAFAssistantErrorDomain cancelled */ {
        emit(.failure, text: "no-speech")
        DispatchQueue.main.async { stopSession() }
      } else {
        DispatchQueue.main.async { stopSession() }
      }
    }
  }
}

dispatchMain()
