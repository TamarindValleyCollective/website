---
title: "2022: Dec 11/16 - The Lambda Retreat"
date: 2022-12-16
excerpt: "A week long exploration into the nature of computation, abstractions, programming paradigms and programming languages. “My aim is to show that the heavenly machine is not a kind of divine, live being, but a kind of clockwork...' — Johannes Kepler (letter to Herwart von Hohenburg,"
coverImage: "/images/events/2022-12-16-the-lambda-retreat/hero.png"
tags: ["retreat"]
---

A week long exploration into the nature of computation, abstractions, programming paradigms and programming languages.

## Overview

> “My aim is to show that the heavenly machine is not a kind of divine, live being, but a kind of clockwork..."
> 
> — Johannes Kepler (letter to Herwart von Hohenburg, 1605)

What are the fundamental building blocks of computing? How can we understand the computing processes from the first principles? What are the tools and techniques to build complex software and reason about their behavior?

[Structure and interpretation of computer programs (SICP) by Abelson and Sussman](https://mitp-content-server.mit.edu/books/content/sectbyfn/books_pres_0/6515/sicp.zip/full-text/book/book.html), famously known as the wizard book, is a very influential textbook with many insights into the nature of computation. Starting with building abstractions with functions and data, it goes all the way to creating programming languages with different execution models and compiling them to register machines .

The Lambda Retreat is a week-long retreat away from the city, with intense discussions with a small group of people, to study this great work. This immersive workshop not only covers most of the topics from the book, but also includes interesting diversions throughout.

To make best use of the time at the retreat, two weeks of prior preparation, with a couple of online sessions per week, is planned before the retreat to get started and pick up a good pace, covering the initial topics of the book.

During immersive workshop, you will solve a bunch of non-trivial problems, write programs in multiple programming paradigms, create a couple of programming languages with different semantics and even compile them to web assembly to run them in the browser!

Sounds interesting? Are you up for the challenge?

## What people say about SICP

> This is one of the great classics of computer science. I bought my first copy 15 years ago, and I still don’t feel I have learned everything the book has to teach.
> 
> — [Paul Graham](http://paulgraham.com/) (from [his review on amazon.com, two decades ago](https://www.amazon.com/review/R3G05B1TQ5XGZP/?_encoding=UTF8&ASIN=0262510871&camp=1789&channel=detail-glance&creative=390957&linkCode=ur2&nodeID=283155&store=books))

> …if you’re like me, you’re not looking for one more trick, rather you’re looking for a way of synthesizing what you already know, and building a rich framework onto which you can add new learning over a career. That’s what SICP has done for me. I read a draft version of the book around 1982, when I was in grad school, and it changed the way I think about my profession. If you’re a thoughtful computer scientist (or want to be one), it will change your life too.
> 
> — [Peter Norvig](http://norvig.com/) (from [his review on amazon.com](https://www.amazon.com/review/R403HR4VL71K8/?_encoding=UTF8&ASIN=0262510871&camp=1789&channel=detail-glance&creative=390957&linkCode=ur2&nodeID=283155&store=books))

> Reading SICP will enlighten you as a programmer, and make you a better one. I can’t imagine one programmer who won’t gain something important by reading SICP.
> 
> — [Eli Bendersky](http://eli.thegreenplace.net/2008/05/28/book-review-structure-and-interpretation-of-computer-programs-by-harold-abelson-gerald-jay-sussman/)

## Target Audience

This course is for you if:

\- you are a passionate programmer looking for deeper insights into the craft of programming

\- you are a self-taught programmer interested to learn many deep and interesting ideas of computer science

\- you are a senior engineer interested to learn how to build extensible systems

\- you are an experienced developer looking for a challenge to build something impossible in a week!

## Prerequisites

This course requires strong programming experience. You should be comfortable to write recursive functions and working with recursive data structures.

Prior experience with any functional programming language is be useful to have, but not necessary.

## Schedule

#### Warm Up

_Nov 28 - Dec 09, 2022_

We'll use the two weeks before the main course to get started and pick up a good pace before the retreat, covering almost the first two chapters of SICP.

There will be online discussions on Tuesdays and Fridays.

Some readings and programming exercises will be shared before each session and the participants are expected to complete them before each session.

\[Tue Nov 29\] Iterative & Recursive Processes

Discuss sections 1.1 and 1.2 of SICP, covering linear recursion and iteration, tree recursion and orders of growth.

\[Fri Dec 02\] Higher-Order Functions

Discuss sections 1.3 of SICP, covering lambda, functions as arguments and functions as return values.

\[Tue Dec 06\] Building Abstractions with Data

Discuss sections 2.1 and part of 2.2 of SICP, covering list operations and sequences.

\[Fri Dec 09\] Hierarchical Structures

Discuss section 2.2 of SICP, covering hierarchical structures and sequence operators.

  

#### The Retreat

_Dec 11 - Dec 16, 2022_

At the retreat, there will be four sessions per day of presentation, live coding and intense discussions.

Some morning and evening activities are planned every day to make the retreat even more fun.

*   Day 0 - Sun Dec 11: Getting Ready

Reach the venue by Sunday evening. We'll have a small orientation session to prepare you for the deep-dive.

*   Day 1 - Mon Dec 12: Building Abstractions with Data

Explores ideas of hierarchical data, multiple representations of data, data encapsulation, types.

One of the interesting parts of this chapter is _A Picture Language_, to compose pictures using higher-order operations. We'll take a small detour and explore the works of [M. C. Escher](https://en.wikipedia.org/wiki/M._C._Escher).

*   Day 2 - Tue Dec 13: Modularity, Objects and State

Strategies to structure large programs to make them modular. Two approaches, an object-based approach with mutable state and a stream-processing approach, will be discussed along the issues they bring. We'll also discuss concurrency and the it's conflict with mutable state and the need of serialization.

*   Day 3: Meta Linguistic Abstraction

As we confront increasingly complex problems, any fixed programming language is not sufficient for our needs. We must constantly turn to new languages in order to express our ideas more expressively. 

We'll learn how to construct evaluators for a bunch of programming languages with different semantics. This includes a scheme interpreter written in scheme, an interpreter with lazy evaluation, and an interpreter with support for non-determinism.

*   Day 4: The Assembly

The last chapter of SICP is _Computing with Register Machines_, covering simulating a register machine and writing a compiler to translate scheme programs to be executed on the register machines.

We'll take a detour and create a simulator for web assembly, build a scheme compiler for web assembly, and run it a browser!

*   Day 5: Beyond SICP

The SICP book covers many interesting ideas, but how do we put them into practice?

Can we build systems that are highly extensible, where the end users can extend and even possibly modify every aspect of the system?

We'll discuss a couple of case studies and explore the challenges and possibilities.

## The Instructor

This course is led by [Anand Chitipothu](https://anandology.com/).

Anand started his career writing a garbage collector for an implementation of scheme and the spirit of SICP stayed with him ever since.

As someone who loves simplicity and likes to approach things from first principles, he was naturally attracted to ideas of functional programming. Some of his works include a Python to Javascript translator, a Python 3 interpreter in Racket, exploring Escher's tessellations with code, among many others.

Over his long career, spanning over two decades, he co-authored web.py - a micro web framework in Python, built Open Library at the Internet Archive, created Joy - a creative coding library in Python, and trained hundreds of engineers through his deep-dive courses.