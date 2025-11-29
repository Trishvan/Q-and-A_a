const emb = await client.featureExtraction({
    model: "thenlper/gte-large:novita",
    inputs: "hello world"
});
console.log(emb);
