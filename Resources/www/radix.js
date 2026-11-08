/* Radix prefix cache. Edge split follows SGLang RadixAttention (Apache-2.0). Clean-room. */
(function () {
  function common(a, b) {
    var n = Math.min(a.length, b.length), i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
  }
  function Node(key) { this.key = key; this.children = []; this.value = undefined; }
  function Cache() { this.root = new Node(""); }
  Cache.prototype.insert = function (key, value) { this._put(this.root, key, value); };
  Cache.prototype._put = function (node, key, value) {
    for (var i = 0; i < node.children.length; i++) {
      var child = node.children[i];
      var n = common(child.key, key);
      if (!n) continue;
      if (n === child.key.length) {
        var rest = key.slice(n);
        if (!rest) child.value = value;
        else this._put(child, rest, value);
        return;
      }
      var mid = new Node(child.key.slice(0, n));
      child.key = child.key.slice(n);
      mid.children.push(child);
      var tail = key.slice(n);
      if (tail) {
        var leaf = new Node(tail);
        leaf.value = value;
        mid.children.push(leaf);
      } else mid.value = value;
      node.children[i] = mid;
      return;
    }
    var created = new Node(key);
    created.value = value;
    node.children.push(created);
  };
  Cache.prototype.match = function (key) {
    var node = this.root, rest = key, matched = "";
    while (rest) {
      var found = null, n = 0;
      for (var i = 0; i < node.children.length; i++) {
        var m = common(node.children[i].key, rest);
        if (m) { found = node.children[i]; n = m; break; }
      }
      if (!found) break;
      if (n < found.key.length) return { matched: matched + found.key.slice(0, n), exact: null };
      matched += found.key;
      rest = rest.slice(found.key.length);
      node = found;
    }
    if (!rest && node.value !== undefined) return { matched: matched, exact: node.value };
    return { matched: matched, exact: null };
  };
  window.NoxRadix = Cache;
})();
