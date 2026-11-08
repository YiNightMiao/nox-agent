#import "NoxBridge.h"
#import <fcntl.h>
#import <signal.h>
#import <spawn.h>
#import <sys/select.h>
#import <sys/wait.h>
#import <unistd.h>

extern char **environ;

static NSString *NoxRoot(void) {
	static NSString *root;
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		NSFileManager *fm = NSFileManager.defaultManager;
		NSString *preferred = @"/var/mobile/Documents/Nox";
		NSString *docs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
		NSString *fallback = [docs stringByAppendingPathComponent:@"Nox"];
		NSString *chosen = preferred;
		if (![fm isWritableFileAtPath:@"/var/mobile/Documents"]) chosen = fallback;
		[fm createDirectoryAtPath:chosen withIntermediateDirectories:YES attributes:nil error:nil];
		if (![fm isWritableFileAtPath:chosen]) chosen = fallback;
		[fm createDirectoryAtPath:chosen withIntermediateDirectories:YES attributes:nil error:nil];
		root = chosen;
	});
	return root;
}

static NSString *JSONString(id object) {
	if (!object || object == NSNull.null) return @"null";
	NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
	if (!data) return @"null";
	return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

static NSString *SafePath(NSString *rel, NSString **error) {
	if (![rel isKindOfClass:NSString.class]) rel = @"";
	if ([rel containsString:@"\0"] || [rel hasPrefix:@"/"]) {
		if (error) *error = @"路径不合法";
		return nil;
	}
	NSString *root = NoxRoot();
	NSString *joined = rel.length ? [root stringByAppendingPathComponent:rel] : root;
	NSString *std = joined.stringByStandardizingPath;
	NSString *rootStd = root.stringByStandardizingPath;
	if (![std isEqualToString:rootStd] && ![std hasPrefix:[rootStd stringByAppendingString:@"/"]]) {
		if (error) *error = @"路径越出了工作区";
		return nil;
	}
	return std;
}

static NSString *Blocked(NSString *command) {
	NSString *lower = command.lowercaseString;
	NSArray *needles = @[
		@"rm -rf /", @"rm -fr /", @"mkfs", @"dd if=", @"> /dev/", @"reboot", @"shutdown",
		@"keychain", @"/etc/passwd", @"/etc/master.passwd", @"launchctl reboot"
	];
	for (NSString *needle in needles) {
		if ([lower containsString:needle]) return @"这条命令被拒绝了";
	}
	if (command.length > 400) return @"命令太长";
	return nil;
}

@interface NoxBridge ()
@property (nonatomic, strong) NSURLSession *session;
@property (nonatomic, strong) NSMutableDictionary<NSNumber *, NSString *> *taskIDs;
@property (nonatomic, strong) NSMutableDictionary<NSNumber *, NSNumber *> *taskStatus;
@property (nonatomic, strong) NSMutableDictionary<NSNumber *, NSMutableData *> *taskError;
@end

@implementation NoxBridge

- (instancetype)init {
	self = [super init];
	if (self) {
		NSURLSessionConfiguration *config = NSURLSessionConfiguration.defaultSessionConfiguration;
		config.timeoutIntervalForRequest = 120;
		self.session = [NSURLSession sessionWithConfiguration:config delegate:self delegateQueue:nil];
		self.taskIDs = [NSMutableDictionary dictionary];
		self.taskStatus = [NSMutableDictionary dictionary];
		self.taskError = [NSMutableDictionary dictionary];
		(void)NoxRoot();
	}
	return self;
}

- (NSUserDefaults *)defaults {
	return NSUserDefaults.standardUserDefaults;
}

- (void)eval:(NSString *)script {
	dispatch_async(dispatch_get_main_queue(), ^{
		[self.webView evaluateJavaScript:script completionHandler:^(id result, NSError *error) {
			(void)result;
			(void)error;
		}];
	});
}

- (void)reply:(NSString *)ident ok:(BOOL)ok value:(id)value {
	NSString *js = [NSString stringWithFormat:@"window.__noxResult(%@,%@,%@)", JSONString(ident), ok ? @"true" : @"false", JSONString(value)];
	[self eval:js];
}

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
	(void)controller;
	if (![message.body isKindOfClass:NSDictionary.class]) return;
	NSDictionary *body = message.body;
	NSString *ident = [body[@"id"] isKindOfClass:NSString.class] ? body[@"id"] : @"";
	NSString *op = [body[@"op"] isKindOfClass:NSString.class] ? body[@"op"] : @"";
	if ([op isEqualToString:@"settings.get"]) {
		NSString *base = [self.defaults stringForKey:@"nox.base"] ?: @"https://api.x.ai/v1";
		NSString *model = [self.defaults stringForKey:@"nox.model"] ?: @"grok-4.5";
		BOOL hasKey = [self.defaults stringForKey:@"nox.key"].length > 0;
		[self reply:ident ok:YES value:@{@"base": base, @"model": model, @"hasKey": @(hasKey), @"root": NoxRoot()}];
		return;
	}
	if ([op isEqualToString:@"settings.set"]) {
		NSString *base = [body[@"base"] isKindOfClass:NSString.class] ? body[@"base"] : @"";
		NSString *model = [body[@"model"] isKindOfClass:NSString.class] ? body[@"model"] : @"";
		NSString *key = [body[@"key"] isKindOfClass:NSString.class] ? body[@"key"] : @"";
		if (base.length && ![base hasPrefix:@"https://"]) {
			[self reply:ident ok:NO value:@"接口只接受 https"];
			return;
		}
		if (base.length) [self.defaults setObject:base forKey:@"nox.base"];
		if (model.length) [self.defaults setObject:model forKey:@"nox.model"];
		if (key.length) [self.defaults setObject:key forKey:@"nox.key"];
		[self reply:ident ok:YES value:@{@"saved": @YES}];
		return;
	}
	if ([op isEqualToString:@"fs.list"]) {
		NSString *err = nil;
		NSString *dir = SafePath([body[@"dir"] isKindOfClass:NSString.class] ? body[@"dir"] : @"", &err);
		if (!dir) {
			[self reply:ident ok:NO value:err];
			return;
		}
		NSFileManager *fm = NSFileManager.defaultManager;
		NSString *root = NoxRoot().stringByStandardizingPath;
		NSDirectoryEnumerator *enumerator = [fm enumeratorAtPath:dir];
		NSMutableArray *rows = [NSMutableArray array];
		for (NSString *name in enumerator) {
			if ([name hasPrefix:@"."]) continue;
			NSString *full = [dir stringByAppendingPathComponent:name];
			BOOL isDir = NO;
			[fm fileExistsAtPath:full isDirectory:&isDir];
			if (isDir) continue;
			NSString *rel = full.stringByStandardizingPath;
			if ([rel hasPrefix:[root stringByAppendingString:@"/"]]) rel = [rel substringFromIndex:root.length + 1];
			[rows addObject:@{@"name": rel, @"dir": @NO}];
			if (rows.count >= 200) break;
		}
		[self reply:ident ok:YES value:rows];
		return;
	}
	if ([op isEqualToString:@"fs.read"]) {
		NSString *err = nil;
		NSString *path = SafePath(body[@"path"], &err);
		if (!path) {
			[self reply:ident ok:NO value:err];
			return;
		}
		NSData *data = [NSData dataWithContentsOfFile:path];
		if (!data) {
			[self reply:ident ok:NO value:@"找不到文件"];
			return;
		}
		if (data.length > 200000) data = [data subdataWithRange:NSMakeRange(0, 200000)];
		NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"";
		[self reply:ident ok:YES value:text];
		return;
	}
	if ([op isEqualToString:@"fs.write"]) {
		NSString *err = nil;
		NSString *path = SafePath(body[@"path"], &err);
		NSString *content = [body[@"content"] isKindOfClass:NSString.class] ? body[@"content"] : @"";
		if (!path) {
			[self reply:ident ok:NO value:err];
			return;
		}
		if (content.length > 200000) {
			[self reply:ident ok:NO value:@"内容超过 200KB"];
			return;
		}
		[NSFileManager.defaultManager createDirectoryAtPath:path.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:nil];
		NSError *writeError = nil;
		BOOL ok = [content writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:&writeError];
		[self reply:ident ok:ok value:ok ? @"已写入" : (writeError.localizedDescription ?: @"写入失败")];
		return;
	}
	if ([op isEqualToString:@"shell"]) {
		NSString *command = [body[@"command"] isKindOfClass:NSString.class] ? body[@"command"] : @"";
		NSString *why = Blocked(command);
		if (why) {
			[self reply:ident ok:NO value:why];
			return;
		}
		dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
			NSString *output = [self run:command];
			[self reply:ident ok:YES value:output ?: @""];
		});
		return;
	}
	if ([op isEqualToString:@"chat"]) {
		[self startChat:body ident:ident];
		return;
	}
	[self reply:ident ok:NO value:@"未知操作"];
}

- (NSString *)shellPath {
	for (NSString *path in @[ @"/var/jb/usr/bin/sh", @"/var/jb/bin/sh", @"/bin/sh" ]) {
		if ([NSFileManager.defaultManager isExecutableFileAtPath:path]) return path;
	}
	return @"/bin/sh";
}

- (NSString *)run:(NSString *)command {
	int pipes[2];
	if (pipe(pipes) != 0) return @"无法建立管道";
	posix_spawn_file_actions_t actions;
	posix_spawn_file_actions_init(&actions);
	posix_spawn_file_actions_adddup2(&actions, pipes[1], STDOUT_FILENO);
	posix_spawn_file_actions_adddup2(&actions, pipes[1], STDERR_FILENO);
	posix_spawn_file_actions_addclose(&actions, pipes[0]);
	posix_spawn_file_actions_addchdir_np(&actions, NoxRoot().UTF8String);
	posix_spawnattr_t attr;
	posix_spawnattr_init(&attr);
	NSString *shell = [self shellPath];
	char *argv[] = {(char *)shell.UTF8String, "-c", (char *)command.UTF8String, NULL};
	pid_t pid = 0;
	int code = posix_spawn(&pid, shell.UTF8String, &actions, &attr, argv, environ);
	posix_spawn_file_actions_destroy(&actions);
	posix_spawnattr_destroy(&attr);
	close(pipes[1]);
	if (code != 0) {
		close(pipes[0]);
		return [NSString stringWithFormat:@"无法启动命令 (%d)", code];
	}
	NSMutableData *data = [NSMutableData data];
	NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:20];
	while (NSDate.date.timeIntervalSinceReferenceDate < deadline.timeIntervalSinceReferenceDate) {
		fd_set set;
		FD_ZERO(&set);
		FD_SET(pipes[0], &set);
		struct timeval tv = {.tv_sec = 0, .tv_usec = 200000};
		int ready = select(pipes[0] + 1, &set, NULL, NULL, &tv);
		if (ready > 0) {
			char buf[1024];
			ssize_t n = read(pipes[0], buf, sizeof(buf));
			if (n <= 0) break;
			[data appendBytes:buf length:(NSUInteger)n];
			if (data.length > 48000) break;
		} else {
			int status = 0;
			if (waitpid(pid, &status, WNOHANG) == pid) break;
		}
	}
	kill(pid, SIGKILL);
	waitpid(pid, NULL, 0);
	int flags = fcntl(pipes[0], F_GETFL, 0);
	fcntl(pipes[0], F_SETFL, flags | O_NONBLOCK);
	while (data.length < 48000) {
		char buf[1024];
		ssize_t n = read(pipes[0], buf, sizeof(buf));
		if (n <= 0) break;
		[data appendBytes:buf length:(NSUInteger)n];
	}
	close(pipes[0]);
	NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
	return text ?: @"";
}

- (void)startChat:(NSDictionary *)body ident:(NSString *)ident {
	NSString *key = [self.defaults stringForKey:@"nox.key"] ?: @"";
	NSString *base = [self.defaults stringForKey:@"nox.base"] ?: @"https://api.x.ai/v1";
	NSString *thread = [body[@"threadId"] isKindOfClass:NSString.class] ? body[@"threadId"] : @"";
	NSString *json = [body[@"json"] isKindOfClass:NSString.class] ? body[@"json"] : @"";
	if (!key.length) {
		[self reply:ident ok:NO value:@"先在设置里保存 API key"];
		return;
	}
	if (![base hasPrefix:@"https://"] || !thread.length || !json.length) {
		[self reply:ident ok:NO value:@"请求不完整"];
		return;
	}
	while ([base hasSuffix:@"/"]) base = [base substringToIndex:base.length - 1];
	NSURL *url = [NSURL URLWithString:[base stringByAppendingString:@"/chat/completions"]];
	if (!url) {
		[self reply:ident ok:NO value:@"接口地址不合法"];
		return;
	}
	NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
	request.HTTPMethod = @"POST";
	[request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
	[request setValue:[@"Bearer " stringByAppendingString:key] forHTTPHeaderField:@"Authorization"];
	[request setValue:[@"nox-" stringByAppendingString:thread] forHTTPHeaderField:@"x-grok-conv-id"];
	request.HTTPBody = [json dataUsingEncoding:NSUTF8StringEncoding];
	NSURLSessionDataTask *task = [self.session dataTaskWithRequest:request];
	@synchronized (self) {
		self.taskIDs[@(task.taskIdentifier)] = ident;
		self.taskStatus[@(task.taskIdentifier)] = @0;
		self.taskError[@(task.taskIdentifier)] = [NSMutableData data];
	}
	[self reply:ident ok:YES value:@{@"started": @YES}];
	[task resume];
}

- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)dataTask didReceiveResponse:(NSURLResponse *)response completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
	(void)session;
	NSInteger status = 0;
	if ([response isKindOfClass:NSHTTPURLResponse.class]) status = [(NSHTTPURLResponse *)response statusCode];
	@synchronized (self) {
		self.taskStatus[@(dataTask.taskIdentifier)] = @(status);
	}
	completionHandler(NSURLSessionResponseAllow);
}

- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)dataTask didReceiveData:(NSData *)data {
	(void)session;
	NSString *ident = nil;
	NSInteger status = 0;
	@synchronized (self) {
		ident = self.taskIDs[@(dataTask.taskIdentifier)];
		status = self.taskStatus[@(dataTask.taskIdentifier)].integerValue;
		if (status >= 400) [self.taskError[@(dataTask.taskIdentifier)] appendData:data];
	}
	if (!ident || status >= 400) return;
	NSString *b64 = [data base64EncodedStringWithOptions:0];
	[self eval:[NSString stringWithFormat:@"window.__noxChunk(%@,%@)", JSONString(ident), JSONString(b64)]];
}

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
	(void)session;
	NSString *ident = nil;
	NSInteger status = 0;
	NSData *errData = nil;
	@synchronized (self) {
		NSNumber *key = @(task.taskIdentifier);
		ident = self.taskIDs[key];
		status = self.taskStatus[key].integerValue;
		errData = self.taskError[key];
		[self.taskIDs removeObjectForKey:key];
		[self.taskStatus removeObjectForKey:key];
		[self.taskError removeObjectForKey:key];
	}
	if (!ident) return;
	if (error) {
		[self eval:[NSString stringWithFormat:@"window.__noxFail(%@,%@)", JSONString(ident), JSONString(error.localizedDescription ?: @"网络错误")]];
		return;
	}
	if (status >= 400) {
		NSString *text = [[NSString alloc] initWithData:errData encoding:NSUTF8StringEncoding] ?: @"模型错误";
		if (text.length > 400) text = [text substringToIndex:400];
		[self eval:[NSString stringWithFormat:@"window.__noxFail(%@,%@)", JSONString(ident), JSONString(text)]];
		return;
	}
	[self eval:[NSString stringWithFormat:@"window.__noxDone(%@)", JSONString(ident)]];
}

@end
