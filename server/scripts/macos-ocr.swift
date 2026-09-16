// Распознавание текста на изображении средствами macOS Vision.
//
// Помощник вызывается сервером (`src/lib/ocr/macosVision.ts`) один раз на страницу:
// `macos-ocr <путь к изображению> [langs]`, где `langs` — коды BCP-47 через запятую.
// Результат — распознанные строки в порядке чтения, по одной на строку в stdout.
//
// Файл компилируется `swiftc -O` в кэш и переиспользуется: запуск через
// `swift script.swift` стоит ~3.5 с на страницу против ~0.3 с у собранного бинаря.
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1 else { FileHandle.standardError.write("usage: ocr <image> [langs]\n".data(using:.utf8)!); exit(2) }
let langs = args.count > 2 ? args[2].split(separator: ",").map(String.init) : ["ru-RU","en-US"]
guard let img = NSImage(contentsOfFile: args[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("cannot read image\n".data(using:.utf8)!); exit(3)
}
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = true
req.recognitionLanguages = langs
try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
let lines = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
print(lines.joined(separator: "\n"))
