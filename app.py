import streamlit as st

st.set_page_config(page_title="My Streamlit App", page_icon="🌟")

st.title("Welcome to your Streamlit App! 🎈")

st.write(
    "I noticed you tried running `your_script.py` earlier—that was just my placeholder example, "
    "which is why it gave a 'File does not exist' error. But now we have a real script!"
)

st.header("What would you like to build?")
st.write("Streamlit is great for data dashboards, AI prototypes, and small internal tools.")

# A quick interactive example
user_idea = st.text_input("Describe your app idea:")
if user_idea:
    st.success(f"Awesome! Let's start building a: {user_idea}")
