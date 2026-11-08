#import "AppDelegate.h"
#import "NoxViewController.h"

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
	(void)application;
	(void)launchOptions;
	self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
	self.window.backgroundColor = [UIColor colorWithRed:0.961 green:0.961 blue:0.969 alpha:1];
	self.window.rootViewController = [NoxViewController new];
	[self.window makeKeyAndVisible];
	return YES;
}

@end
