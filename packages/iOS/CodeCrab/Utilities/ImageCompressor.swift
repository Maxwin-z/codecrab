import UIKit

struct ImageCompressor {
    static func compressImage(_ image: UIImage) -> ImageAttachment? {
        let maxDimension: CGFloat = 1568
        var size = image.size
        
        if size.width > maxDimension || size.height > maxDimension {
            let ratio = maxDimension / max(size.width, size.height)
            size = CGSize(width: size.width * ratio, height: size.height * ratio)
        }
        
        UIGraphicsBeginImageContextWithOptions(size, false, 1.0)
        image.draw(in: CGRect(origin: .zero, size: size))
        let resized = UIGraphicsGetImageFromCurrentImageContext() ?? image
        UIGraphicsEndImageContext()
        
        var quality: CGFloat = 0.85
        while quality > 0.1 {
            if let data = resized.jpegData(compressionQuality: quality), data.count <= 5_000_000 {
                return ImageAttachment(
                    data: data.base64EncodedString(),
                    mediaType: "image/jpeg",
                    name: nil
                )
            }
            quality -= 0.1
        }
        return nil
    }
}
