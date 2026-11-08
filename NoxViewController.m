#import "NoxViewController.h"
#import "NoxBridge.h"
#import <WebKit/WebKit.h>

@interface NoxViewController ()
@property (nonatomic, strong) WKWebView *webView;
@property (nonatomic, strong) NoxBridge *bridge;
@end

@implementation NoxViewController

- (void)viewDidLoad {
	[super viewDidLoad];
	self.view.backgroundColor = [UIColor colorWithRed:0.961 green:0.961 blue:0.969 alpha:1];

	WKWebViewConfiguration *config = [WKWebViewConfiguration new];
	WKUserContentController *content = [WKUserContentController new];
	self.bridge = [NoxBridge new];
	[content addScriptMessageHandler:self.bridge name:@"nox"];
	WKUserScript *mark = [[WKUserScript alloc] initWithSource:@"window.__NOX_NATIVE__=true;"
	                                              injectionTime:WKUserScriptInjectionTimeAtDocumentStart
	                                           forMainFrameOnly:YES];
	[content addUserScript:mark];
	config.userContentController = content;

	self.webView = [[WKWebView alloc] initWithFrame:CGRectZero configuration:config];
	self.webView.translatesAutoresizingMaskIntoConstraints = NO;
	self.webView.opaque = YES;
	self.webView.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
	self.webView.scrollView.keyboardDismissMode = UIScrollViewKeyboardDismissModeInteractive;
	self.bridge.webView = self.webView;
	[self.view addSubview:self.webView];
	[NSLayoutConstraint activateConstraints:@[
		[self.webView.topAnchor constraintEqualToAnchor:self.view.topAnchor],
		[self.webView.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],
		[self.webView.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
		[self.webView.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
	]];

	NSURL *url = [NSBundle.mainBundle URLForResource:@"index" withExtension:@"html" subdirectory:@"www"];
	if (url) {
		[self.webView loadFileURL:url allowingReadAccessToURL:url.URLByDeletingLastPathComponent];
	}
}

- (void)dealloc {
	[self.webView.configuration.userContentController removeScriptMessageHandlerForName:@"nox"];
}

@end
