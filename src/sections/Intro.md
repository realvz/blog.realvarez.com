---
title: "Home"
layout: "base.njk"
permalink: "/"
order: 1
---

# 👋 Hi there!

Hi, I am Re (pronounced like Ray). I work at AWS as a Principal Solutions Architect where I spend my days designing resilient systems that scale.

In my free time, I'm fascinated by another kind of system: the psychological ones that shape how we love, hurt, and heal.

I look for patterns wherever I can find them—in distributed architectures, family dynamics, and the gap between words and meaning. I like to read for insight into human nature, dance (poorly) to reggaeton songs, and write about whatever catches my attention. I write to learn. My writing explores both the architecture of software and the architecture of transformation.

Living beneath the tall evergreens in Washington State has taught me that building a peaceful family is harder—and more rewarding—than building any system.

I've written a book about building ML systems on Kubernetes. It is [available for purchase on Amazon](https://www.amazon.com/dp/B0FQ4BFHLV)and also [open sourced for free on GitHub](https://github.com/mlops-on-kubernetes/Book).

PS: My older posts are on [Medium](https://medium.com/@realz)

Opinions expressed are solely my own and do not express the views or opinions of my employer.

---

## Recent Posts

<ul class="blogList">
  {% for post in collections.blog %}
  <li class=blogListItem>
    <a href="{{ post.url }}">{{ post.data.title }}</a> - {{ post.date | date("yyyy-MM-dd") }}
    <p>{{ post.data.description }}</p>
  </li>
  {% endfor %}
</ul>
