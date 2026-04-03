---
title: "Home"
layout: "base.njk"
permalink: "/"
order: 1
description: "Re Alvarez Parmar writes about AI infrastructure, Kubernetes, distributed systems, and the human side of technical work."
---

# 👋 Hello!

Hi, I am Re (pronounced like Ray). I work at Nebius as a Principal Cloud Solutions Architect. Most of my work is around GPU infrastructure, Kubernetes, and distributed systems. Before this, I spent ten years at AWS as a containers guy, helping customers modernize their applications and services.

Outside work, I read and write about psychology, philosophy, and whatever else I am trying to understand.

I like distributed systems, family stories, and books that help me make better sense of people. I read Dostoevsky, Frank Herbert, Barbara Kingsolver, and a lot of philosophy. I write because it helps me think.

I live in the Pacific Northwest with my family. When I am not in front of my computer, I like going on hikes with them.

I've written a book about building ML systems on Kubernetes. It is [available for purchase on Amazon](https://www.amazon.com/dp/B0FQ4BFHLV) and also [open sourced for free on GitHub](https://github.com/mlops-on-kubernetes/Book).

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
