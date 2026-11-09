---
'latkit': patch
---

Rows that stand at different heights sort again in a quarter of the GPU time, and only every 0.1 s while their heights stream in.

- Changed: sorting rows by height takes about a quarter of the GPU time it did: 21 ms instead of 83 ms for the 1.2 million line segments of a 100,000-bus grid on a globe.
- Changed: while heights change in every frame, as when they stream in, a view sorts them again at most every 0.1 s, and once more after they stop. A picture or video frame always draws every row in order.
- Changed: heights within about 0.01% of each other count as one, and keep their table order.
