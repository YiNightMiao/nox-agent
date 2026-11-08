export THEOS_PACKAGE_SCHEME = rootless
TARGET := iphone:clang:latest:16.0
ARCHS := arm64 arm64e
INSTALL_TARGET_PROCESSES := Nox

include $(THEOS)/makefiles/common.mk

APPLICATION_NAME := Nox

Nox_FILES := main.m AppDelegate.m NoxViewController.m NoxBridge.m
Nox_FRAMEWORKS := UIKit WebKit CoreGraphics
Nox_CFLAGS := -fobjc-arc
Nox_CODESIGN_FLAGS := -Sentitlements.plist
Nox_RESOURCE_DIRS := Resources
Nox_INSTALL_PATH := /Applications

include $(THEOS_MAKE_PATH)/application.mk

before-all::
	@mkdir -p Resources
	@python3 -c 'import base64,pathlib; pathlib.Path("Resources/Icon-60@2x.png").write_bytes(base64.b64decode(pathlib.Path("icon-120.b64").read_text()))'
	@python3 -c 'import base64,pathlib; pathlib.Path("Resources/Icon-60@3x.png").write_bytes(base64.b64decode(pathlib.Path("icon-180.b64").read_text()))'
