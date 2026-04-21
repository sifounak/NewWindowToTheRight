# What's New in Version 4.0

## 🐛 Bug Fixes

**Fixed: Windows no longer have gap when wrapping to left edge**
- When a new window wraps to the left side of the screen, it now appears flush against the edge with no visible gap
- Previously, a 7-pixel gap was visible due to Chrome's invisible resize borders

## ⚡ Performance & Compatibility Improvements

**Updated for latest Chrome Extension APIs**
- Replaced deprecated APIs to ensure compatibility with current and future Chrome versions
- Modernized codebase to use native Chrome promise-based APIs
- Improved code efficiency with async/await patterns

## 📦 Under the Hood

- Complete code modernization (22% reduction in code size)
- Better error handling and reliability
- Maintained full support for rapid window creation (Ctrl+N spam, shift-clicking multiple links)
- All core functionality preserved:
  - ✅ 15px offset when opening windows to the right
  - ✅ Automatic wrapping at screen edges
  - ✅ Multi-monitor support
  - ✅ Matching parent window dimensions

---

**Full Changelog**: https://github.com/sifounak/NewWindowToTheRight/compare/46321be...v4.0

*This release includes significant modernization work while maintaining 100% backward compatibility with existing behavior.*
