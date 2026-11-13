# Roblox Up-and-Coming top 10 forecast

An entry for the make.fun bounty [Predict Roblox's Up-and-Coming top 10](https://make.fun/bounty/roblox-up-and-coming-forecast-01).

## What it does

`main.ts` reads the history of Roblox's Up-and-Coming chart (device computer, country US) and writes one
forecast for the 72 hours after the history ends: for each of the chart's top 10 places, a probability
for each game it names being at that place, plus its best guess at the top 10 in order.

- Input: `history.ndjson` (one read of the chart per line, oldest first) and `task.json` (the window).
- Output: `forecast.json`, one object with two keys:

```json
{
  "probabilities": [
    {"universe_id": 10772946647, "place": 1, "p": 0.31},
    {"universe_id": 10773926254, "place": 1, "p": 0.12}
  ],
  "top10": [10772946647, 10773926254, 10772543706, 10769671316, 10770575733,
            10771881861, 10772114384, 10772749430, 10771928551, 10772281976]
}
```

The program is deterministic: the same history gives the same bytes.

## The model

- For each place k it estimates, from pairs of reads in the history whose lag matches the window's
  lags, how much of the window place k is held by a game now at each rank, or by a game not on the
  chart yet. A wide kernel over rank is the prior that keeps the table smooth.
- Every game on the last chart is named at every place with its share, so the unnamed mass falls
  only on games that join the chart later.
- A game that climbed in the last hours counts as if ranked a little higher; one that fell, lower.
- When the history carries a game's created date, its share shrinks with the part of the window
  after it turns 28 days old and leaves the chart.

## How it is scored

The one forecast is scored against every hourly read of the chart in the 72-hour window. At each read
and each place 1 to 10, the score is the natural log of the probability the forecast gave the game
that really held the place, floored at 0.0001. A game not named at a place gets that place's unnamed
share (1 minus the sum of the place's rows) divided by the number of games on that read's chart not
named there. A read's score is the sum over the 10 places; the log score is the mean over the reads.
Higher is better and 0 is perfect. Ties go to the top-10 agreement of `top10`.

## Run it locally

Node 22 or later, standard library only:

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=path/to/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`path/to/input` holds `history.ndjson` and `task.json` as the bounty's kit ships them. The forecast
lands in `out/forecast.json`.
