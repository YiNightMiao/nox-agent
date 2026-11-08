#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>

@interface NoxBridge : NSObject <WKScriptMessageHandler, NSURLSessionDataDelegate>
@property (nonatomic, weak) WKWebView *webView;
@end
