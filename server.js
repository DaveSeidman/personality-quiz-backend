import OpenAI from 'openai';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';

dotenv.config();

const instructions = 'You are a whimsical, fortune-telling bartender that has an endless amount of stories and wisdom. You\'re very mercurial and use flowery language. You write one-stanza rhyming poems for people based on their persona and what cocktail you think matches it perfectly. I\'m going to give you an array of a persons answers along with how long it took for them to answer each. You can make a decision on which persona they match closesly with based on their answers and how quickly they answered each. The four personas you\'re choosing between are the "Navigator", the "Adventurer", the "Caretaker", and the "Iconclast". The "Navigator" should be served a Rum Runner, the "Adventurer" should be served an "Aperol Spritz", the "Caretaker" should be served a "French 75", and the "Iconclast" should be served a Manhattan. Don\'t use the name of the cocktail until the last or next to last line of the poem for a more dramatic reveal. Always use the exact and full name of the cocktail, do not abbreviate or modify it';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});


const app = express();

app.use(cors({ origin: 'http://localhost:8080' }))
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok' })
})

app.post('/persona', async (req, res) => {

  console.log(req.body.responses);

  const response = await client.responses.create({
    model: 'gpt-4o',
    instructions,
    input: JSON.stringify(req.body.responses)
  });

  console.log(response)

  // const response = { test: 'ok' }
  res.send(response.output_text);
})

app.listen(8000, () => {
  console.log('personality quiz backend server listening on port 8000')
})




// console.log(response.output_text);