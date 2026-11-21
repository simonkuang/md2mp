---
title: 完整元素测试文章
author: 测试作者
digest: 这是一篇覆盖全部 Markdown 元素的测试文档。
tags: [测试, md2mp]
---

# 一级标题

这是**粗体**、*斜体*、~~删除线~~与 `行内代码`。这里有一段包含中英文混排mixed的文本用于测试自动空格。

## 二级标题

普通段落，包含一个[外部链接](https://example.com)和一个自动链接 https://example.org 。

> 这是一段引用文字。
> 第二行引用。

### 三级标题

- 无序列表项一
- 无序列表项二
  - 嵌套项

1. 有序列表一
2. 有序列表二

- [x] 已完成任务
- [ ] 未完成任务

#### 四级标题

| 列1 | 列2 | 列3 |
| --- | --- | --- |
| a | b | c |
| d | e | f |

```js
const greet = (name) => {
  console.log(`Hello, ${name}`);
  return true;
};
```

```python
def add(a, b):
    return a + b
```

---

:::tip
这是一段提示容器内容。
:::

:::warning
这是一段警告容器内容。
:::

脚注测试[^1]。

[^1]: 这是脚注内容。

![测试图片](./test.png)

以上是结尾段落。
