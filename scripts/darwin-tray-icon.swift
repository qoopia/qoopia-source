import AppKit

// Render the canonical small-size mark, retaining its rounded 9-unit stroke.
final class Mark: NSObject, XMLParserDelegate {
    var data = ""
    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
        if name == "path" { data = attributes["d"] ?? "" }
    }
}
let mark = Mark()
let parser = XMLParser(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))!
parser.delegate = mark
precondition(parser.parse() && !mark.data.isEmpty, "Canonical mark missing")
let regex = try NSRegularExpression(pattern: "[MC]|-?[0-9]+(?:\\.[0-9]+)?")
let tokens = regex.matches(in: mark.data, range: NSRange(mark.data.startIndex..., in: mark.data)).map { (mark.data as NSString).substring(with: $0.range) }
let path = CGMutablePath()
var i = 0
func number() -> CGFloat { defer { i += 1 }; return CGFloat(Double(tokens[i])!) }
while i < tokens.count {
    let command = tokens[i]; i += 1
    if command == "M" { path.move(to: CGPoint(x: number(), y: number())) }
    else if command == "C" { let a = CGPoint(x: number(), y: number()), b = CGPoint(x: number(), y: number()), c = CGPoint(x: number(), y: number()); path.addCurve(to: c, control1: a, control2: b) }
    else { fatalError("Unsupported canonical mark command") }
}
let bounds = path.boundingBoxOfPath.insetBy(dx: -4.5, dy: -4.5)
let image = NSImage(size: NSSize(width: 20, height: 18))
for scale in [1, 2] {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 20 * scale, pixelsHigh: 18 * scale, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let context = NSGraphicsContext(bitmapImageRep: bitmap)!.cgContext
    let factor = min(18 / bounds.width, 16 / bounds.height)
    context.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
    context.translateBy(x: (20 - bounds.width * factor) / 2, y: (18 + bounds.height * factor) / 2)
    context.scaleBy(x: factor, y: -factor)
    context.translateBy(x: -bounds.minX, y: -bounds.minY)
    context.addPath(path); context.setStrokeColor(NSColor.black.cgColor); context.setLineWidth(9); context.setLineCap(.round); context.strokePath()
    bitmap.size = image.size; image.addRepresentation(bitmap)
}
try image.tiffRepresentation!.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
